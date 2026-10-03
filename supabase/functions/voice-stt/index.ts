// Codeply: speech to text for voice calls.
//
// The phone sends one utterance (16 kHz mono WAV, a few seconds) and gets the
// words back from Whisper large-v3-turbo on Groq: far more accurate than the
// small model that can run on a phone, and back in a few hundred ms. Same
// sign-in and Groq keys as ai-proxy; the phone falls back to its on-device
// model when this is unreachable.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const GROQ_API_KEYS: string[] = (Deno.env.get("GROQ_API_KEYS") ?? Deno.env.get("GROQ_API_KEY") ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const STT_MODEL = Deno.env.get("STT_MODEL") || "whisper-large-v3-turbo";
const MAX_BYTES = 16000 * 2 * 30 + 44; // 30 s of 16 kHz mono 16-bit

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-prompt",
  "Access-Control-Expose-Headers": "server-timing",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return new Response(null, { status: 204, headers: CORS }); // wake-up ping
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const t0 = Date.now();
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in to use calls." }, 401);
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.length < 100 || audio.length > MAX_BYTES) return json({ success: false, error: "Send 0.1 to 30 seconds of 16 kHz WAV." }, 400);
    // Words the bot just said or names in the chat help Whisper spell things right.
    const hint = decodeURIComponent(req.headers.get("x-prompt") ?? "").slice(0, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const userP = supabase.auth.getUser(token);
    const sttP = (async () => {
      let last = "Speech to text unavailable";
      for (const key of GROQ_API_KEYS) {
        const form = new FormData();
        form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
        form.append("model", STT_MODEL);
        form.append("language", "en");
        form.append("response_format", "json");
        form.append("temperature", "0");
        if (hint) form.append("prompt", hint);
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true as const, text: String(data.text || "").trim() };
        last = data?.error?.message || `HTTP ${res.status}`;
        if (!/rate limit|429|quota/i.test(last)) break;
      }
      return { ok: false as const, error: last };
    })();
    const { data: { user }, error: authErr } = await userP;
    if (authErr || !user) return json({ success: false, error: "Sign in to use calls." }, 401);
    const r = await sttP;
    const timing = { "Server-Timing": `total;dur=${Date.now() - t0}` };
    if (!r.ok) return json({ success: false, error: r.error }, 502, timing);
    // Whisper's usual guesses for silence or noise.
    const text = /^[\s.,!?-]*$/.test(r.text) || /^\(?\[?(blank_audio|music|silence|inaudible|noise|thank you\.?)\]?\)?\.?$/i.test(r.text) ? "" : r.text;
    return json({ success: true, text }, 200, timing);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[voice-stt]", msg);
    return json({ success: false, error: msg }, 500);
  }
});
