// Codeply: one streaming round trip per voice-call turn (the ChatGPT-voice idea
// with our own parts).
//
// The phone sends the bot's prompt, the call so far and the bot's voice. This
// function streams the reply from the fast model word by word; the moment a
// sentence is complete it has Deepgram Aura-2 speak it, and streams that audio
// straight back while the model keeps writing. The phone starts playing the
// first sentence while the rest is still being made.
//
// If the user wants real work (email, files, ...), the model says one short
// natural line and then writes [[WORK: <task>]]; that comes through as a
// "work" event and the phone hands it to the PC's agent.
// Reminders ("call me at 7") come as [[REMIND: <ISO time> | <repeat> | <kind> | <text>]]
// tags: taken out of the speech (never said) and sent as "remind" events; the
// phone saves them through the reminders function.
//
// Response: NDJSON lines
//   {"t":"say","i":0,"text":"..."}           a sentence, in order
//   {"t":"audio","i":0,"mime":"audio/mpeg","b64":"..."}  its audio (may be missing: then the phone's voice says it)
//   {"t":"remind","at":"...","repeat":"none","kind":"call","text":"..."}  a reminder to save
//   {"t":"work","task":"..."}                 real work for the PC
//   {"t":"done"} | {"t":"error","error":"..."}
// Same sign-in, daily request cap and voice character budget as ai-proxy and tts-proxy.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY") ?? "";
const GROQ_API_KEYS: string[] = (Deno.env.get("GROQ_API_KEYS") ?? Deno.env.get("GROQ_API_KEY") ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const MODEL = Deno.env.get("VOICE_MODEL") || "openai/gpt-oss-20b"; // quickest first words on Groq; good enough for talk
const REMIND_MODEL = Deno.env.get("VOICE_REMIND_MODEL") || "openai/gpt-oss-120b";
const REMIND_TALK = /\b(remind|reminder|call me|ring me|wake me|check (in|on) me|plan (my|the|out)|my day|schedule|snooze|tomorrow|tonight|this (morning|afternoon|evening)|in (a|an|\d+|ten|five|twenty|thirty) (min|minute|hour)|o'?clock|\d{1,2}(:\d\d)?\s*(am|pm|a\.m\.|p\.m\.))/i;
const DAILY_REQUEST_CAP = 400;
const TTS_DAILY_CHARS = Number(Deno.env.get("TTS_DAILY_CHARS") || 20000);
const DEFAULT_VOICE = "aura-2-thalia-en";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** Groq's streamed reply as plain text pieces (reasoning left out). */
const MODELS_OK = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "moonshotai/kimi-k2-instruct"];
async function* groqStream(messages: unknown, maxTokens: number, signal: AbortSignal, model = MODEL): AsyncGenerator<string> {
  let res: Response | null = null; let last = "AI engine unavailable";
  for (const key of GROQ_API_KEYS) {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, messages, temperature: 0.7, max_tokens: maxTokens, stream: true,
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low", include_reasoning: false } : {}),
      }),
    });
    if (res.ok && res.body) break;
    last = (await res.text().catch(() => "")).slice(0, 200) || `HTTP ${res.status}`;
    res = null;
    if (!/rate limit|429|quota|tokens per/i.test(last)) break;
  }
  if (!res || !res.body) throw new Error(last);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { const piece = JSON.parse(data).choices?.[0]?.delta?.content; if (piece) yield piece; } catch { /* keep going */ }
    }
  }
}

async function speak(text: string, voice: string, userId: string): Promise<{ bytes: Uint8Array | null; ms: number }> {
  const t0 = Date.now();
  if (!DEEPGRAM_API_KEY) return { bytes: null, ms: 0 };
  // The budget check (database) and the speech (Deepgram) at the same time;
  // over the budget, the audio is dropped and the phone's voice says it.
  const budgetP = service.rpc("add_tts_chars", { p_user: userId, p_chars: text.length });
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`, {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) { console.error("[voice-turn] deepgram", res.status); return { bytes: null, ms: Date.now() - t0 }; }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { data: used } = await budgetP;
  if (typeof used === "number" && used > TTS_DAILY_CHARS) return { bytes: null, ms: Date.now() - t0 };
  return { bytes, ms: Date.now() - t0 };
}

/**
 * A sentence as streamed raw PCM (signed 16-bit, 24 kHz mono): Deepgram sends
 * it while it is still making the rest, so the first sound is out in a few
 * hundred milliseconds instead of after the whole sentence.
 */
const PCM_RATE = 24000;
async function speakStream(text: string, voice: string): Promise<ReadableStreamDefaultReader<Uint8Array> | null> {
  if (!DEEPGRAM_API_KEY) return null;
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=linear16&container=none&sample_rate=${PCM_RATE}`, {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) { console.error("[voice-turn] deepgram", res.status); return null; }
  return res.body.getReader();
}

/** Whisper large-v3-turbo on Groq: the words in one utterance (16 kHz WAV), or "" for silence and noise. */
async function transcribe(wav: Uint8Array, hint: string): Promise<string> {
  for (const key of GROQ_API_KEYS) {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "en");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (hint) form.append("prompt", hint);
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = String(data.text || "").trim();
      return /^[\s.,!?-]*$/.test(text) || /^\(?\[?(blank_audio|music|silence|inaudible|noise|thank you\.?)\]?\)?\.?$/i.test(text) ? "" : text;
    }
    if (!/rate limit|429|quota/i.test(String(data?.error?.message || ""))) break;
  }
  throw new Error("Speech to text failed.");
}

/** Where the next sentence ends in `s`, or -1. The first piece may end at a comma to start talking sooner. */
// Fluency: every piece is voiced on its own, so a cut resets the intonation.
// The first piece is one whole sentence (split at a comma only when it is very
// long, to start talking sooner); later pieces gather short sentences into one
// of ~80+ characters so they are said with natural flow. Later pieces are made
// while the earlier ones play, so the gathering costs no waiting.
const MIN_LATER = 80;
function sentenceEnd(s: string, first: boolean): number {
  const re = /[.!?]+["')\]]*(\s|$)/g;
  let m: RegExpExecArray | null;
  let end = -1;
  while ((m = re.exec(s))) {
    if (m.index <= 1 && s.length <= 3) continue;
    end = m.index + m[0].length;
    if (first || end >= MIN_LATER) return end;
  }
  if (first) {
    const words = s.trim().split(/\s+/);
    if (words.length > 18) {
      const c = /[,;:]\s/g; let cm: RegExpExecArray | null;
      while ((cm = c.exec(s))) if (s.slice(0, cm.index).trim().split(/\s+/).length >= 6) return cm.index + cm[0].length;
    }
  }
  return -1;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return new Response(null, { status: 204, headers: CORS }); // wake-up ping
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ success: false, error: "Sign in to use calls." }, 401);
  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
  // In audio mode the last user message comes from the audio (see below).
  if (!messages.length) return json({ success: false, error: "messages[] required" }, 400);
  const voice = /^aura-2-[a-z]+-[a-z]{2}$/.test(String(body?.voice ?? "")) ? String(body.voice) : DEFAULT_VOICE;
  const pcm = body?.format === "pcm";
  const maxTokens = Math.min(500, Math.max(60, Number(body?.maxTokens) || 300));

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  // Sign-in, the daily cap and the voice budget all at once. The budget read
  // uses the token's user id before the sign-in check returns; nothing is
  // spent or sent unless that check passes.
  let claimedId = "";
  try { claimedId = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub || ""; } catch { /* checked below */ }
  const authP = supabase.auth.getUser(token);
  const countP = supabase.rpc("get_daily_ai_request_count");
  const voiceP = claimedId ? service.rpc("add_tts_chars", { p_user: claimedId, p_chars: 0 })
    .then(({ data }) => !(typeof data === "number" && data > TTS_DAILY_CHARS)).catch(() => true) : Promise.resolve(false);

  // Audio in: what the user said, heard by Whisper large-v3-turbo, joins the
  // conversation; the phone gets it first as a "heard" event.
  let heard: string | null = null;
  if (typeof body?.audio_b64 === "string" && body.audio_b64.length > 100) {
    const [{ data: a }] = await Promise.all([authP]);
    if (!a?.user) return json({ success: false, error: "Sign in to use calls." }, 401);
    heard = await transcribe(decodeBase64(body.audio_b64), String(body?.hint ?? "").slice(0, 400));
    if (!heard) {
      return new Response(`${JSON.stringify({ t: "heard", text: "" })}\n${JSON.stringify({ t: "done" })}\n`,
        { headers: { ...CORS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
    }
    messages.push({ role: "user", content: heard });
  }

  // Start the model at once; the checks finish while it warms up.
  const ctl = new AbortController();
  // Reminders and day plans need a time worked out and a [[REMIND: ...]] tag
  // written every time: the small model sometimes forgets the tag, so those
  // turns go to the bigger one.
  const recentTalk = messages.slice(-3).filter((m: { role?: string }) => m?.role !== "system").map((m: { content?: unknown }) => String(m?.content ?? "")).join(" ");
  const aboutTime = REMIND_TALK.test(recentTalk);
  const model = MODELS_OK.includes(String(body?.model)) ? String(body.model) : aboutTime ? REMIND_MODEL : MODEL;
  const pieces = groqStream(messages, maxTokens, ctl.signal, model);
  const firstPiece = pieces.next(); // kicks off the request
  const [{ data: { user }, error: authErr }, { data: count }] = await Promise.all([authP, countP]);
  const voiceOk = user && user.id === claimedId ? await voiceP : false;
  if (authErr || !user) { ctl.abort(); return json({ success: false, error: "Sign in to use calls." }, 401); }
  if (typeof count === "number" && count >= DAILY_REQUEST_CAP) {
    ctl.abort();
    return json({ success: false, error: `Daily AI request limit reached (${DAILY_REQUEST_CAP}/day). Resets at midnight UTC.` }, 429);
  }
  const recordP = supabase.rpc("record_ai_request");

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      if (heard !== null) send({ t: "heard", text: heard });
      let pending = ""; let index = 0; let all = ""; let work: string | null = null;
      // Audio is made in parallel but sent in order.
      let chain: Promise<void> = Promise.resolve();
      const emit = (sentence: string) => {
        // Nothing that cannot be said: emojis, symbols, markdown.
        const text = sentence.replace(/\s*[—–]\s*/g, ", ").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}*_#`>~]/gu, "").replace(/\s+/g, " ").trim();
        if (!/[\p{L}\p{N}]/u.test(text)) return;
        const i = index++;
        if (pcm) {
          // Started now, sent in order: sentence i streams after sentence i-1 ends.
          const t0 = Date.now();
          const readerP = voiceOk ? speakStream(text, voice).catch(() => null) : Promise.resolve(null);
          if (voiceOk) service.rpc("add_tts_chars", { p_user: user.id, p_chars: text.length }).then(() => {}, () => {});
          chain = chain.then(async () => {
            send({ t: "say", i, text });
            const reader = await readerP;
            if (!reader) return;
            let carry: Uint8Array | null = null; let pend: Uint8Array[] = []; let pendLen = 0; let first = true;
            const flush = () => {
              if (!pendLen) return;
              let all = new Uint8Array(pendLen); let o = 0;
              for (const p of pend) { all.set(p, o); o += p.length; }
              pend = []; pendLen = 0;
              if (all.length % 2) { carry = all.slice(-1); all = all.slice(0, -1); }
              send({ t: "pcm", i, rate: PCM_RATE, ...(first ? { ms: Date.now() - t0 } : {}), b64: encodeBase64(all) });
              first = false;
            };
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (carry) { const m = new Uint8Array(carry.length + value.length); m.set(carry); m.set(value, carry.length); pend.push(m); pendLen += m.length; carry = null; }
              else { pend.push(value); pendLen += value.length; }
              // About 0.15 s of sound per message (the first one as soon as possible).
              if (first || pendLen >= PCM_RATE * 2 * 0.15) flush();
            }
            flush();
            send({ t: "end", i });
          });
          return;
        }
        const audioP = voiceOk ? speak(text, voice, user.id).catch(() => ({ bytes: null, ms: -1 })) : Promise.resolve({ bytes: null, ms: 0 });
        chain = chain.then(async () => {
          send({ t: "say", i, text });
          const { bytes, ms } = await audioP;
          if (bytes) send({ t: "audio", i, mime: "audio/mpeg", ms, b64: encodeBase64(bytes) });
        });
      };
      try {
        let step = await firstPiece;
        while (!step.done) {
          all += step.value;
          pending += step.value;
          // Reminder tags are taken out as they complete (never spoken) and
          // sent as events; the talking goes on around them.
          let rm: RegExpExecArray | null;
          while ((rm = /\[\[\s*REMIND\s*:\s*([\s\S]*?)\]\]/i.exec(pending))) {
            const [at, repeat, kind, ...text] = rm[1].split("|").map((x) => x.trim());
            send({ t: "remind", at: at || "", repeat: repeat || "none", kind: kind || "remind", text: text.join(" | ") });
            pending = pending.slice(0, rm.index) + pending.slice(rm.index + rm[0].length);
          }
          // The work tag: everything from "[[" on is held back until it resolves.
          const tag = pending.indexOf("[[");
          let speakable = tag >= 0 ? pending.slice(0, tag) : pending;
          let end;
          while ((end = sentenceEnd(speakable, index === 0)) >= 0) {
            emit(speakable.slice(0, end));
            pending = pending.slice(end);
            speakable = speakable.slice(end);
          }
          const m = /\[\[\s*WORK\s*:\s*([\s\S]*?)\]\]/i.exec(pending);
          if (m) { work = m[1].trim(); pending = pending.slice(0, m.index); ctl.abort(); break; }
          step = await pieces.next();
        }
      } catch (e) {
        if (!ctl.signal.aborted || !work) send({ t: "error", error: e instanceof Error ? e.message : String(e) });
      }
      const rest = pending.replace(/\[\[[\s\S]*$/, "").trim();
      if (rest) emit(rest);
      await chain;
      if (work) send({ t: "work", task: work });
      send({ t: "done" });
      controller.close();
      // Bookkeeping after the call has its answer.
      const after = Promise.allSettled([recordP, supabase.from("usage_history").insert({
        user_id: user.id, model: MODEL, tokens_in: 0, tokens_out: Math.round(all.length / 4), tokens_total: Math.round(all.length / 4),
        prompt_text: "voice call", file_path: "",
      })]);
      // deno-lint-ignore no-explicit-any
      const rt = (globalThis as any).EdgeRuntime;
      if (rt && rt.waitUntil) rt.waitUntil(after);
    },
    cancel() { ctl.abort(); },
  });
  return new Response(stream, { headers: { ...CORS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
});
