// Codeply — centralized AI proxy
//
// The app never holds a Groq/OpenRouter key itself (see lib/groq.js) — every
// AI call goes through this function instead, authenticated by the caller's
// Supabase session. This is what makes the DOWNLOADED app plug-and-play
// without shipping a real secret inside the binary (anyone can extract a key
// embedded in a distributed Electron app; nobody can extract a key that
// never leaves this server).
//
// Groq stays primary; OpenRouter is a fallback ONLY when every configured
// Groq key is rate-limited, mirroring the logic that used to live client-side
// in lib/groq.js / lib/openrouter.js before this proxy existed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;
// Auto-provided in every Supabase Edge Function — bypasses RLS, used ONLY
// for the internal proxy_key_state bookkeeping table below, never for
// anything user-owned (that stays on the anon+JWT client so RLS still
// applies normally to the caller's own rows).
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";

// GROQ_API_KEYS is a comma-separated pool ("key1,key2,key3") so multiple
// free-tier accounts' quotas can be combined; GROQ_API_KEY (singular) still
// works as a one-key fallback for anyone who hasn't switched over.
const GROQ_API_KEYS: string[] = (Deno.env.get("GROQ_API_KEYS") ?? Deno.env.get("GROQ_API_KEY") ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

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

// ─── Groq key rotation (persisted in proxy_key_state, service-role only) ────

function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** The key index to try first. Resets to 0 if the stored state is from a previous UTC day. */
async function getActiveKeyIndex(): Promise<number> {
  try {
    const { data, error } = await serviceClient()
      .from("proxy_key_state")
      .select("current_index, updated_on")
      .eq("id", 1)
      .single();
    if (error || !data) return 0;
    const today = new Date().toISOString().slice(0, 10);
    if (data.updated_on !== today) return 0;
    return Math.min(Math.max(0, data.current_index ?? 0), GROQ_API_KEYS.length - 1);
  } catch {
    return 0;
  }
}

/** Persist the key that actually worked, so the NEXT request starts there instead of re-trying exhausted keys. */
async function setActiveKeyIndex(idx: number): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await serviceClient()
      .from("proxy_key_state")
      .upsert({ id: 1, current_index: idx, updated_on: today });
  } catch (e) {
    console.warn("[ai-proxy] setActiveKeyIndex failed:", (e as Error).message);
  }
}

async function callGroqOnce(apiKey: string, messages: unknown, opts: { json?: boolean; temperature?: number; maxTokens?: number }) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
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

/**
 * Tries the sticky-default key first, then walks forward through the rest of
 * the pool on a rate-limit error only (a non-rate-limit failure stops
 * immediately — trying five keys against a request that's simply malformed
 * wastes four extra calls for nothing). Whichever key succeeds becomes the
 * new default for every other request today.
 */
async function callGroqWithRotation(messages: unknown, opts: { json?: boolean; temperature?: number; maxTokens?: number }) {
  if (!GROQ_API_KEYS.length) return { success: false as const, error: "AI engine unavailable" };

  const startIndex = await getActiveKeyIndex();
  let lastError = "AI engine unavailable";

  for (let i = startIndex; i < GROQ_API_KEYS.length; i++) {
    const result = await callGroqOnce(GROQ_API_KEYS[i], messages, opts);
    if (result.success) {
      if (i !== startIndex) await setActiveKeyIndex(i);
      return result;
    }
    lastError = result.error;
    if (!isRateLimitError(lastError)) return result; // not a quota issue — rotating won't help
  }
  return { success: false as const, error: lastError };
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

// ─── Usage analytics (usage_history) ────────────────────────────────────────
// One row per successful call, on the CALLER's own anon+JWT client so the
// existing "users can insert their own usage_history row" RLS policy applies
// exactly as it did when the desktop app logged this client-side. Both the
// desktop app and the CLI go through this same function now, so both show up
// in the admin dashboard (previously only the desktop app logged this itself
// — the CLI was invisible to admin-stats.js).
async function logUsage(
  userClient: ReturnType<typeof createClient>,
  userId: string,
  result: { data?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }; modelUsed?: string },
  meta: { promptText?: string; filePath?: string } | undefined,
) {
  try {
    const usage = result.data?.usage || {};
    await userClient.from("usage_history").insert({
      user_id: userId,
      model: result.modelUsed || "",
      tokens_in: usage.prompt_tokens || 0,
      tokens_out: usage.completion_tokens || 0,
      tokens_total: usage.total_tokens || 0,
      prompt_text: String(meta?.promptText || "").slice(0, 300),
      file_path: String(meta?.filePath || "").slice(0, 500),
    });
  } catch (e) {
    console.warn("[ai-proxy] logUsage failed:", (e as Error).message);
  }
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

    const { messages, opts, meta } = await req.json();
    if (!Array.isArray(messages) || !messages.length) {
      return json({ success: false, error: "messages[] required" }, 400);
    }

    // Record the attempt before calling out, so a genuine attempt always
    // counts toward the cap even if the provider call itself fails midway.
    const { error: recordErr } = await supabase.rpc("record_ai_request");
    if (recordErr) console.warn("[ai-proxy] record_ai_request failed:", recordErr.message);

    const primary = await callGroqWithRotation(messages, opts || {});
    if (primary.success) {
      await logUsage(supabase, user.id, primary, meta);
      return json(primary);
    }

    if (isRateLimitError(primary.error) && OPENROUTER_API_KEY) {
      const fallback = await callOpenRouter(messages, opts || {});
      if (fallback.success) {
        await logUsage(supabase, user.id, fallback, meta);
        return json(fallback);
      }
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
