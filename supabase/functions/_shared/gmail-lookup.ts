// Gmail for the bots on a call, from Codeply's server: works with the user's PC
// off. When the talk is about email and the user has linked Gmail for the phone
// (mail_links, or the always-on watcher's mail_watch_accounts), this finds the
// emails they mean and hands them to the bot as context before it speaks.
//
// Read only: search and read. Sending or drafting still goes through [[WORK]]
// (the PC or Codeply Cloud), where the user approves it.
//
// Two quick steps, so a call keeps flowing: a small model call turns what the
// user said into a Gmail search, then the matches (and the body of the best
// one, when they want it read) come back as a short block of text.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { open } from "./mail-crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GROQ_API_KEYS: string[] = (Deno.env.get("GROQ_API_KEYS") ?? Deno.env.get("GROQ_API_KEY") ?? "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const PLAN_MODEL = Deno.env.get("MAIL_PLAN_MODEL") || "openai/gpt-oss-20b"; // fast: a call is waiting
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** Talk that is about email. Anything else skips the lookup and costs nothing. */
export const MAIL_TALK = /\b(e-?mails?|inbox|gmail|mail(s|box)?|unread|newsletters?|sender|replied|reply|replies|wrote to me|sent me|message from)\b/i;

/** The sealed Gmail sign-in for this user: the phone link first, then the watcher's. */
async function sealedFor(userId: string): Promise<string | null> {
  const { data: link } = await service.from("mail_links").select("token_enc").eq("user_id", userId).maybeSingle();
  if (link?.token_enc) return link.token_enc;
  const { data: acc } = await service.from("mail_watch_accounts").select("token_enc").eq("user_id", userId).maybeSingle();
  return acc?.token_enc ?? null;
}

async function accessToken(sealed: string, userId: string): Promise<string> {
  const g = JSON.parse(await open(sealed, userId));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: "refresh_token" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(body.error === "invalid_grant" ? "The Gmail sign-in expired. Reconnect Gmail in Craft." : `Gmail sign-in failed (HTTP ${res.status}).`);
  return body.access_token;
}

async function gmailGet(token: string, p: string) {
  const res = await fetch(`${GMAIL}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail returned HTTP ${res.status}.`);
  return await res.json();
}

/** What to search for, decided from the last few lines of the call. */
async function plan(talk: string, now: string): Promise<{ query: string; read: boolean } | null> {
  const messages = [
    { role: "system", content: "Turn the user's request about their email into one Gmail search. Answer with JSON only: {\"query\": \"a Gmail search like from:someone@x.com newer_than:7d, or is:unread, or a few keywords\", \"read\": true if they want an email's content read or summarised, false for a quick overview}. Keep queries simple; prefer recent mail (newer_than:14d) unless they name a time. If it is not about their email at all, answer {\"query\": \"\"}. Today is " + now + "." },
    { role: "user", content: talk.slice(-1500) },
  ];
  for (const key of GROQ_API_KEYS) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: PLAN_MODEL, messages, temperature: 0, max_tokens: 200, response_format: { type: "json_object" }, ...(PLAN_MODEL.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      try {
        const j = JSON.parse(data.choices?.[0]?.message?.content || "{}");
        const query = String(j.query || "").trim().slice(0, 300);
        return query ? { query, read: !!j.read } : null;
      } catch { return null; }
    }
    if (!/rate limit|429|quota|tokens per/i.test(String(data?.error?.message || ""))) break;
  }
  return null;
}

const header = (m: { payload?: { headers?: { name: string; value: string }[] } }, name: string) =>
  (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function bodyOf(part: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    try { return new TextDecoder().decode(Uint8Array.from(atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return ""; }
  }
  for (const p of (part.parts ?? []) as typeof part[]) { const t = bodyOf(p); if (t) return t; }
  return "";
}

/**
 * The inbox block for the bot, or null when the talk is not about email.
 * Returns { text } on success, or { text } explaining why it could not look
 * (not linked, sign-in expired), so the bot can say it plainly.
 */
export async function inboxContext(userId: string, talk: string, tz = "UTC"): Promise<string | null> {
  if (!MAIL_TALK.test(talk)) return null;
  const sealed = await sealedFor(userId);
  if (!sealed) return "GMAIL: not linked for calls. If they ask about email, say you can read it on calls once they turn on \"Use Gmail from my phone\" in Craft, under Crew, account, Connected apps.";
  let now = new Date().toISOString();
  try { now = new Date().toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }); } catch { /* UTC */ }
  const p = await plan(talk, now);
  if (!p) return null;
  try {
    const token = await accessToken(sealed, userId);
    const list = await gmailGet(token, `/messages?maxResults=6&q=${encodeURIComponent(p.query)}`);
    const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
    if (!ids.length) return `GMAIL (live, searched "${p.query}"): no emails match.`;
    const metas = await Promise.all(ids.map((id) => gmailGet(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const lines = metas.map((m, i) => `${i + 1}. From ${header(m, "From")} | ${header(m, "Subject") || "(no subject)"} | ${header(m, "Date")}${(m.labelIds ?? []).includes("UNREAD") ? " | unread" : ""}\n   ${String(m.snippet ?? "").slice(0, 220)}`);
    let full = "";
    if (p.read) {
      const m = await gmailGet(token, `/messages/${ids[0]}?format=full`);
      full = `\n\nTHE FIRST ONE IN FULL:\n${bodyOf(m.payload ?? {}).replace(/\s+\n/g, "\n").slice(0, 2500)}`;
    }
    return `GMAIL (live from the user's inbox just now, searched "${p.query}"):\n${lines.join("\n")}${full}\n\nAnswer from this. Reading email needs no [[WORK]]; only sending or drafting does.`;
  } catch (e) {
    return `GMAIL: could not read the inbox (${e instanceof Error ? e.message : String(e)}). Say so plainly.`;
  }
}
