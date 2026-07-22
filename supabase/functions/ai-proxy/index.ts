// Codeply — centralized AI proxy
//
// The app never holds a Groq/OpenRouter key itself (see lib/groq.js) — every
// AI call goes through this function instead, authenticated by the caller's
// Supabase session. This is what makes the DOWNLOADED app plug-and-play
// without shipping a real secret inside the binary (anyone can extract a key
// embedded in a distributed Electron app; nobody can extract a key that
// never leaves this server).
//
// Groq stays primary; OpenRouter is a fallback ONLY when Groq is genuinely
// rate-limited, mirroring the logic that used to live client-side in
// lib/groq.js / lib/openrouter.js before this proxy existed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GROQ_API_KEY       = Deno.env.get("GROQ_API_KEY") ?? "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

const GROQ_URL  = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

const OPENROUTER_URL   = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = Deno.env.get("OPENROUTER_MODEL") || "poolside/laguna-xs-2.1:free";

// Same server owns the budget every user draws from, so this cap protects
// YOUR Groq/OpenRouter bill, not any one user's own usage. A single edit can
// cost several raw calls (self-correction retries, surgical-edit-then-full-
// rewrite fallback), so it's deliberately higher than the 100/day apply cap
// — see supabase/ai_request_log.sql.
const DAILY_REQUEST_CAP = 400;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isRateLimitError(msg: string): boolean {
  const s = String(msg || "").toLowerCase();
  return s.includes("rate limit") || s.includes("429") || s.includes("tokens per day")
    || s.includes("tokens per minute") || s.includes(" tpd") || s.includes(" tpm")
    || s.includes("quota");
}

async function callGroq(messages: unknown, opts: { json?: boolean; temperature?: number; maxTokens?: number }) {
  if (!GROQ_API_KEY) return { success: false as const, error: "AI engine unavailable" };
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.choices?.[0]) {
    const errMsg = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
    return { success: false as const, error: errMsg };
  }
  return { success: true as const, data, modelUsed: GROQ_MODEL };
}

async function callOpenRouter(messages: unknown, opts: { json?: boolean; temperature?: number }) {
  if (!OPENROUTER_API_KEY) return { success: false as const, error: "OpenRouter fallback unavailable" };
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://codeply.app",
      "X-Title": "Codeply",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: opts.temperature ?? 0,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.choices?.[0]) {
    const errMsg = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
    return { success: false as const, error: errMsg };
  }
  return { success: true as const, data, modelUsed: OPENROUTER_MODEL };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in to use AI features." }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ success: false, error: "Sign in to use AI features." }, 401);

    // Budget check BEFORE spending anything — a user at the cap costs us
    // nothing further today, no matter how many times they retry.
    const { data: countData, error: countErr } = await supabase.rpc("get_daily_ai_request_count");
    if (countErr) throw countErr;
    if (typeof countData === "number" && countData >= DAILY_REQUEST_CAP) {
      return json({ success: false, error: `Daily AI request limit reached (${DAILY_REQUEST_CAP}/day). Resets at midnight UTC.` }, 429);
    }

    const { messages, opts } = await req.json();
    if (!Array.isArray(messages) || !messages.length) {
      return json({ success: false, error: "messages[] required" }, 400);
    }

    // Record the attempt before calling out, so a genuine attempt always
    // counts toward the cap even if the provider call itself fails midway.
    const { error: recordErr } = await supabase.rpc("record_ai_request");
    if (recordErr) console.warn("[ai-proxy] record_ai_request failed:", recordErr.message);

    const primary = await callGroq(messages, opts || {});
    if (primary.success) return json(primary);

    if (isRateLimitError(primary.error) && OPENROUTER_API_KEY) {
      const fallback = await callOpenRouter(messages, opts || {});
      if (fallback.success) return json(fallback);
      return json({ success: false, error: `${primary.error} (OpenRouter fallback also failed: ${fallback.error})` }, 502);
    }

    return json(primary, 502);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai-proxy]", msg);
    return json({ success: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
