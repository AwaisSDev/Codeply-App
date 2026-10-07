// Email importance with no model, for always-on bots in the cloud.
// A copy of scoreMessage / parseMessage in Craft's codeply-cli/lib/mail-watch.js:
// keep WEIGHTS, URGENT and the thresholds the same in both.

export const IMPORTANT_AT = 4;
export const VERY_AT = 7;
export const WEIGHTS = {
  important: 2, starred: 3, personal: 1,
  promotions: -4, social: -3, updates: -2, forums: -3,
  knownSender: 3, directTo: 1, notAddressed: -1,
  bulk: -3, noReply: -2,
  urgentSubject: 2, urgentSubjectMax: 4, urgentSnippet: 1, urgentSnippetMax: 2,
  botKeyword: 2, botKeywordMax: 4, botSender: 3,
};
export const URGENT = ["urgent", "asap", "deadline", "invoice", "contract", "interview", "today", "overdue", "action required", "time sensitive"];
export const META_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "References", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];

export type Mail = {
  id: string; threadId: string; labels: string[]; snippet: string;
  from: string; fromEmail: string; fromName: string; to: string[]; cc: string[]; replyTo: string;
  subject: string; date: string; messageId: string; references: string;
  listUnsubscribe: string; listId: string; precedence: string; autoSubmitted: string;
};
export type Rules = { keywords?: string[]; senders?: string[] };

const lower = (s: unknown) => String(s ?? "").toLowerCase();
const addresses = (v: unknown) => (String(v ?? "").match(/[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/gi) ?? []).map((a) => a.toLowerCase());
function displayName(from: string): string {
  const m = from.trim().match(/^\s*"?([^"<]+?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  return addresses(from)[0] || from || "someone";
}

// deno-lint-ignore no-explicit-any
export function parseMessage(raw: any): Mail {
  const h: Record<string, string> = {};
  for (const x of raw?.payload?.headers ?? []) {
    const k = lower(x.name);
    if (k && !(k in h)) h[k] = String(x.value ?? "");
  }
  return {
    id: String(raw.id ?? ""), threadId: String(raw.threadId ?? raw.id ?? ""), labels: Array.isArray(raw.labelIds) ? raw.labelIds : [],
    snippet: String(raw.snippet ?? ""), from: h.from ?? "", fromEmail: addresses(h.from)[0] ?? "", fromName: displayName(h.from ?? ""),
    to: addresses(h.to), cc: addresses(h.cc), replyTo: addresses(h["reply-to"])[0] ?? "",
    subject: h.subject ?? "", date: h.date ?? "", messageId: h["message-id"] ?? "", references: h.references ?? "",
    listUnsubscribe: h["list-unsubscribe"] ?? "", listId: h["list-id"] ?? "", precedence: h.precedence ?? "", autoSubmitted: h["auto-submitted"] ?? "",
  };
}

const words = (s: unknown) => lower(s).replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
function hits(text: string, list: string[]): string[] {
  const t = ` ${words(text)} `;
  return list.filter((w) => { const x = words(w); return !!x && t.includes(` ${x} `); });
}

export function scoreMessage(m: Mail, ctx: { me: string; knownSender: boolean; rules?: Rules }) {
  const W = WEIGHTS;
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => { if (n) { score += n; reasons.push(`${why} ${n > 0 ? "+" : ""}${n}`); } };
  const L = new Set(m.labels);
  if (L.has("IMPORTANT")) add(W.important, "Gmail marked it important");
  if (L.has("STARRED")) add(W.starred, "starred");
  if (L.has("CATEGORY_PERSONAL")) add(W.personal, "personal");
  if (L.has("CATEGORY_PROMOTIONS")) add(W.promotions, "promotions");
  if (L.has("CATEGORY_SOCIAL")) add(W.social, "social");
  if (L.has("CATEGORY_UPDATES")) add(W.updates, "updates");
  if (L.has("CATEGORY_FORUMS")) add(W.forums, "forums");
  if (ctx.knownSender) add(W.knownSender, "you have emailed them");
  const me = lower(ctx.me);
  if (me && m.to.includes(me)) add(W.directTo, "sent to you");
  else if (me && !m.cc.includes(me)) add(W.notAddressed, "not addressed to you");
  const bulk = !!m.listUnsubscribe || !!m.listId || /^(bulk|list|junk)$/i.test(m.precedence.trim()) ||
    (!!m.autoSubmitted && !/^no$/i.test(m.autoSubmitted.trim()));
  if (bulk) add(W.bulk, "list or automated mail");
  if (/^(no-?reply|do-?not-?reply|notifications?|mailer-daemon)@/i.test(m.fromEmail)) add(W.noReply, "no-reply sender");
  const subj = hits(m.subject, URGENT);
  if (subj.length) add(Math.min(W.urgentSubjectMax, subj.length * W.urgentSubject), `urgent words (${subj.join(", ")})`);
  const snip = hits(m.snippet, URGENT).filter((w) => !subj.includes(w));
  if (snip.length) add(Math.min(W.urgentSnippetMax, snip.length * W.urgentSnippet), "urgent words in the text");
  const rules = ctx.rules ?? {};
  const kw = hits(`${m.subject} ${m.snippet}`, rules.keywords ?? []);
  if (kw.length) add(Math.min(W.botKeywordMax, kw.length * W.botKeyword), `your bot's rules (${kw.slice(0, 3).join(", ")})`);
  const from = lower(m.fromEmail);
  if (from && (rules.senders ?? []).some((s) => { const x = lower(s).replace(/^@/, ""); return !!x && (from === x || from.endsWith(`@${x}`) || from.endsWith(`.${x}`)); })) {
    add(W.botSender, "a sender your bot watches for");
  }
  const level = score >= VERY_AT ? "very" : score >= IMPORTANT_AT ? "important" : "low";
  return { score, level, reasons };
}

/** "22:00" to "07:00" wraps past midnight, in the bot's own time zone. */
export function inQuietHours(quiet: { on?: boolean; from?: string; to?: string } | null, tz: string | null, now = Date.now()): boolean {
  if (!quiet || quiet.on === false) return false;
  const mins = (s?: string) => { const [h, m] = String(s ?? "").split(":").map(Number); return h * 60 + m; };
  const from = mins(quiet.from); const to = mins(quiet.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  let hh = 0; let mm = 0;
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now));
    hh = Number(p.find((x) => x.type === "hour")?.value) % 24; mm = Number(p.find((x) => x.type === "minute")?.value);
  } catch { return false; }
  const t = hh * 60 + mm;
  return from < to ? t >= from && t < to : t >= from || t < to;
}
