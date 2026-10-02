// Codeply: bot voices on calls (Deepgram Aura-2), for every signed-in user.
//
// Same idea as ai-proxy: the Deepgram key lives only here, never in an app.
// The phone sends one sentence at a time with the bot's chosen voice and gets
// mp3 back. Deepgram bills per character (Aura-2: $0.030 per 1,000), so each
// user has a daily character allowance (TTS_DAILY_CHARS, default 20,000, about
// 60 cents and roughly 20 minutes of the bot talking); past it the phone falls
// back to its own built-in voice.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const DAILY_CHARS = Number(Deno.env.get("TTS_DAILY_CHARS") || 20000);
const MAX_CHARS = 600; // one sentence or two; the phone speaks sentence by sentence
const DEFAULT_VOICE = "aura-2-thalia-en";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "x-tts-chars-left",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in to use voices." }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser(token);
    if (authErr || !user) return json({ success: false, error: "Sign in to use voices." }, 401);

    if (!DEEPGRAM_API_KEY) return json({ success: false, error: "Voices are not set up on the server yet." }, 503);

    const body = await req.json().catch(() => ({}));
    const text = String(body?.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
    if (!text) return json({ success: false, error: "Nothing to say." }, 400);
    const voice = /^aura-2-[a-z]+-[a-z]{2}$/.test(String(body?.voice ?? "")) ? String(body.voice) : DEFAULT_VOICE;

    // Count the characters before spending them, so retries cannot run past the cap.
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: used, error: useErr } = await service.rpc("add_tts_chars", { p_user: user.id, p_chars: text.length });
    if (useErr) throw useErr;
    if (typeof used === "number" && used > DAILY_CHARS) {
      return json({ success: false, error: "Daily voice limit reached. Resets at midnight UTC." }, 429);
    }

    const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`, {
      method: "POST",
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[tts-proxy] deepgram", res.status, detail.slice(0, 300));
      return json({ success: false, error: `The voice service failed (${res.status}).` }, 502);
    }
    const left = Math.max(0, DAILY_CHARS - (typeof used === "number" ? used : 0));
    return new Response(res.body, {
      status: 200,
      headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "x-tts-chars-left": String(left) },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[tts-proxy]", msg);
    return json({ success: false, error: msg }, 500);
  }
});
