// Codeply: the fast first reply on voice calls.
//
// Same keys, same daily request cap and the same sign-in as ai-proxy, but
// built for latency: the budget check and the request record run alongside
// the model call instead of before it, usage is logged after the response is
// sent, and the model is asked for minimal reasoning. The phone sends the bot's
// prompt and the call so far and gets {"say", "work"} back (see phone-calls.js
// askFast). The cap still holds: an over-cap request's answer is discarded.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GROQ_API_KEYS: string[] = (Deno.env.get("GROQ_API_KEYS") ?? Deno.env.get("GROQ_API_KEY") ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = Deno.env.get("VOICE_MODEL") || "openai/gpt-oss-120b";
const DAILY_REQUEST_CAP = 400; // same cap as ai-proxy: the combined daily limit

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "server-timing",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

async function groq(messages: unknown, maxTokens: number) {
  let last = "AI engine unavailable";
  for (const key of GROQ_API_KEYS) {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL, messages, temperature: 0.7, max_tokens: maxTokens,
        response_format: { type: "json_object" },
        ...(MODEL.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.choices?.[0]) return { ok: true as const, data };
    last = data?.error?.message || `HTTP ${res.status}`;
    if (!/rate limit|429|quota|tokens per/i.test(last)) break; // only a quota error is worth the next key
  }
  return { ok: false as const, error: last };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return new Response(null, { status: 204, headers: CORS }); // wake-up ping
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const t0 = Date.now(); const marks: string[] = [];
  const mark = (n: string) => marks.push(`${n};dur=${Date.now() - t0}`);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in to use calls." }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
    if (!messages.length) return json({ success: false, error: "messages[] required" }, 400);
    const maxTokens = Math.min(400, Math.max(60, Number(body?.maxTokens) || 260));

    // Sign-in, budget and the model, all at once.
    const userP = supabase.auth.getUser(token).then((r) => { mark("auth"); return r; });
    const countP = supabase.rpc("get_daily_ai_request_count").then((r) => { mark("count"); return r; });
    const modelP = groq(messages, maxTokens).then((r) => { mark("model"); return r; });

    const { data: { user }, error: authErr } = await userP;
    if (authErr || !user) return json({ success: false, error: "Sign in to use calls." }, 401);
    const { data: count } = await countP;
    if (typeof count === "number" && count >= DAILY_REQUEST_CAP) {
      return json({ success: false, error: `Daily AI request limit reached (${DAILY_REQUEST_CAP}/day). Resets at midnight UTC.` }, 429);
    }
    const recordP = supabase.rpc("record_ai_request");
    const result = await modelP;
    if (!result.ok) return json({ success: false, error: result.error }, 502, { "Server-Timing": marks.join(", ") });

    // Bookkeeping after the answer is on its way.
    const usage = result.data.usage || {};
    const after = Promise.allSettled([recordP, supabase.from("usage_history").insert({
      user_id: user.id, model: MODEL, tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0,
      tokens_total: usage.total_tokens || 0, prompt_text: "voice call", file_path: "",
    })]);
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && rt.waitUntil) rt.waitUntil(after); else await after;

    return json({ success: true, data: { choices: result.data.choices, usage } }, 200, { "Server-Timing": marks.join(", ") });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[voice-chat]", msg);
    return json({ success: false, error: msg }, 500);
  }
});
