// Codeply: sends the reminders that are due (run every minute by pg_cron +
// pg_net, see supabase/reminders_cron.sql).
//
// For each due reminder (pending or snoozed, due_at <= now): claim it (mark it
// sent, or move a repeating one to its next time, in the user's own time
// zone), then send a Web Push to each of the user's phones. Push services
// answer 404/410 for a phone that unsubscribed: that subscription is deleted.
// No subscription at all is fine: the reminder still counts as sent and shows
// in the app.
//
// Push payload: { title: bot name, body: text, reminderId, kind, botId, botVoice, key, url, mail? }
// (key is the reminder's action_key: the notification's Snooze button uses it).
//
// Only the cron job may call this: it sends the x-cron-secret header, kept in
// Vault on the database side and in REMINDERS_CRON_SECRET here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("REMINDERS_CRON_SECRET") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@codeply.app";
const BATCH = 200;
const STALE_MS = 6 * 3600_000; // a reminder this late (the sender was down) is not pushed any more

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ─── Repeats, in the user's own time zone ────────────────────────────────────
function wall(t: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t));
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: p.weekday };
}
const offsetAt = (t: number, tz: string) => {
  const w = wall(t, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
};
/** A local wall-clock time in tz -> epoch ms (two passes settle DST changes). */
function fromWall(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = guess - offsetAt(guess, tz);
  return guess - offsetAt(t, tz);
}
/** The next time a repeating reminder is due after now: same local time, next day / weekday / week. */
export function nextDue(dueIso: string, repeat: string, tz: string | null, now: number): string | null {
  const zone = tz || "UTC";
  const base = wall(Date.parse(dueIso), zone);
  for (let day = 1; day < 800; day++) {
    if (repeat === "weekly" && day % 7) continue;
    const t = fromWall(base.y, base.mo, base.d + day, base.h, base.mi, base.s, zone);
    if (repeat === "weekdays" && ["Sat", "Sun"].includes(wall(t, zone).wd)) continue;
    if (t > now) return new Date(t).toISOString();
  }
  return null;
}

type Row = {
  id: string; user_id: string; bot_id: string | null; bot_name: string; bot_voice: string | null; text: string;
  due_at: string; tz: string | null; repeat: string | null; kind: string; status: string; action_key: string; payload: Record<string, unknown> | null;
};
type Sub = { id: string; endpoint: string; keys: { p256dh: string; auth: string } };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  if (!sameSecret(req.headers.get("x-cron-secret") ?? "", CRON_SECRET)) return json({ success: false, error: "Not allowed." }, 401);
  const canPush = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const { data: due, error } = await service.from("reminders")
    .select("id, user_id, bot_id, bot_name, bot_voice, text, due_at, tz, repeat, kind, status, action_key, payload")
    .in("status", ["pending", "snoozed"]).lte("due_at", nowIso).order("due_at", { ascending: true }).limit(BATCH);
  if (error) return json({ success: false, error: error.message }, 500);

  const subsByUser = new Map<string, Promise<Sub[]>>();
  const subsFor = (userId: string) => {
    if (!subsByUser.has(userId)) {
      subsByUser.set(userId, service.from("push_subscriptions").select("id, endpoint, keys").eq("user_id", userId)
        .then(({ data }) => (data ?? []) as Sub[]));
    }
    return subsByUser.get(userId)!;
  };
  const stats = { due: (due ?? []).length, claimed: 0, pushed: 0, failed: 0, removed: 0, noSubscription: 0, stale: 0, repeated: 0 };

  await Promise.all(((due ?? []) as Row[]).map(async (r) => {
    // Claim it first, so two overlapping runs never send the same reminder twice.
    const next = r.repeat ? nextDue(r.due_at, r.repeat, r.tz, now) : null;
    const patch = next ? { due_at: next, status: "pending", sent_at: nowIso } : { status: "sent", sent_at: nowIso };
    const { data: claimed } = await service.from("reminders").update(patch)
      .eq("id", r.id).eq("due_at", r.due_at).in("status", ["pending", "snoozed"]).select("id").maybeSingle();
    if (!claimed) return;
    stats.claimed++;
    if (next) stats.repeated++;
    if (now - Date.parse(r.due_at) > STALE_MS) { stats.stale++; return; }
    const subs = await subsFor(r.user_id);
    if (!subs.length || !canPush) { stats.noSubscription++; return; }
    const payload = JSON.stringify({
      title: r.bot_name || "Codeply", body: r.text, reminderId: r.id, kind: r.kind, botId: r.bot_id, botVoice: r.bot_voice,
      key: r.action_key, url: `/?call=${r.id}`,
      // An always-on bot's important email (mail-watch-tick, or Craft's bots-watch.js): the phone opens Gmail.
      // The draft text stays out (push payloads are small); a call fetches the full reminder.
      ...(r.payload && r.payload.mail && typeof r.payload.mail === "object" ? { mail: (({ from, subject, summary, drafted, level, gmailUrl, draftUrl }) =>
        ({ from, subject, summary: String(summary ?? "").slice(0, 240), drafted, level, gmailUrl, draftUrl }))(r.payload.mail as Record<string, unknown>) } : {}),
    });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 4 * 3600, urgency: "high" });
        stats.pushed++;
      } catch (e) {
        // deno-lint-ignore no-explicit-any
        const code = (e as any)?.statusCode;
        if (code === 404 || code === 410) {
          await service.from("push_subscriptions").delete().eq("id", s.id);
          stats.removed++;
        } else {
          stats.failed++;
          console.error("[reminders-tick] push failed", code ?? "", String((e as Error)?.message ?? e).slice(0, 200));
        }
      }
    }));
  }));
  return json({ success: true, ...stats });
});
