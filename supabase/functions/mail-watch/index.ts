// Codeply: always-on bots in the cloud (Craft's bots-watch.js talks to this).
//
// POST JSON { action, ... } with the user's token (Authorization: Bearer):
//   enable    { email, cursor, gmail: { refreshToken, clientId, clientSecret }, bots: [...] }
//             stores the Gmail sign-in sealed (_shared/mail-crypto.ts) and the
//             watching bots; mail-watch-tick polls while the PC is silent
//   disable   deletes the sign-in, the bots, seen ids and events
//   heartbeat { cursor, seen: [message ids] }   the PC is on and handled these
//   status    { since (ms) }  -> { enabled, cursor, seen, events } what the cloud did
// The sealed sign-in is never returned. Deployed with --no-verify-jwt: the
// token is checked here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { seal } from "../_shared/mail-crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_BOTS = 10;
const REACH = ["message", "push", "call"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean).slice(0, n);
const cursorOf = (v: unknown) => (/^\d{1,20}$/.test(String(v ?? "")) ? String(v) : null);
const msgIds = (v: unknown) => (Array.isArray(v) ? v : []).map(String).filter((x) => /^[0-9a-f]{6,32}$/i.test(x)).slice(0, 200);
const hhmm = (v: unknown, d: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? "")) ? String(v) : d);
function validTz(v: unknown): string | null {
  const s = str(v, 64);
  if (!s) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ success: false, error: "Sign in first." }, 401);
  const { data: { user } } = await service.auth.getUser(token);
  if (!user) return json({ success: false, error: "Your sign-in expired. Sign in again." }, 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const now = new Date().toISOString();

  try {
    if (action === "enable") {
      const g = body?.gmail ?? {};
      const refreshToken = str(g.refreshToken, 2048);
      if (!refreshToken) return json({ success: false, error: "Reconnect Gmail in Connect Apps first." }, 400);
      const token_enc = await seal(JSON.stringify({ refreshToken, clientId: str(g.clientId, 300), clientSecret: str(g.clientSecret, 300) }), user.id);
      const cursor = cursorOf(body?.cursor);
      const { error } = await service.from("mail_watch_accounts").upsert({
        user_id: user.id, email: str(body?.email, 320).toLowerCase(), token_enc, enabled: true,
        desktop_seen_at: now, desktop_cursor: cursor, next_check_at: now, failures: 0, last_error: null, updated_at: now,
      }, { onConflict: "user_id" });
      if (error) throw error;
      // deno-lint-ignore no-explicit-any
      const bots = (Array.isArray(body?.bots) ? body.bots : []).slice(0, MAX_BOTS).map((b: any) => ({
        user_id: user.id, bot_id: str(b.id, 60), name: str(b.name, 40) || "Codeply", voice: str(b.voice, 80) || null,
        specialty: str(b.specialty, 200), instructions: str(b.instructions, 4000), tone: str(b.tone, 400),
        memory: list(b.memory, 15, 240), keywords: list(b.keywords, 15, 40), senders: list(b.senders, 10, 120),
        reach: REACH.includes(b.reach) ? b.reach : "push", draft: b.draft !== false,
        // deno-lint-ignore no-explicit-any
        alerts: (Array.isArray(b.alerts) ? b.alerts : []).slice(0, 20).map((x: any) => ({ from: str(x?.from, 200).toLowerCase(), how: x?.how === "call" ? "call" : "text", repeat: !!x?.repeat })).filter((x: { from: string }) => x.from),
        quiet: { on: b.quiet?.on !== false, from: hhmm(b.quiet?.from, "22:00"), to: hhmm(b.quiet?.to, "07:00") }, tz: validTz(b.tz),
      })).filter((b: { bot_id: string }) => /^[a-z0-9-]{1,60}$/.test(b.bot_id));
      await service.from("mail_watch_bots").delete().eq("user_id", user.id);
      if (bots.length) {
        const { error: e2 } = await service.from("mail_watch_bots").insert(bots);
        if (e2) throw e2;
      }
      return json({ success: true, bots: bots.length });
    }

    if (action === "disable") {
      for (const t of ["mail_watch_bots", "mail_watch_seen", "mail_watch_events", "mail_watch_accounts"]) {
        await service.from(t).delete().eq("user_id", user.id);
      }
      return json({ success: true });
    }

    if (action === "heartbeat") {
      const patch: Record<string, unknown> = { desktop_seen_at: now, updated_at: now };
      const cursor = cursorOf(body?.cursor);
      if (cursor) patch.desktop_cursor = cursor;
      await service.from("mail_watch_accounts").update(patch).eq("user_id", user.id);
      const ids = msgIds(body?.seen);
      if (ids.length) {
        await service.from("mail_watch_seen").upsert(ids.map((message_id) => ({ user_id: user.id, message_id })), { onConflict: "user_id,message_id", ignoreDuplicates: true });
      }
      return json({ success: true });
    }

    if (action === "status") {
      const { data: acc } = await service.from("mail_watch_accounts").select("enabled, cloud_cursor, last_check, last_error").eq("user_id", user.id).maybeSingle();
      if (!acc) return json({ success: true, enabled: false, cursor: null, seen: [], events: [] });
      const since = new Date(Math.max(0, Number(body?.since) || 0)).toISOString();
      const [{ data: seen }, { data: events }] = await Promise.all([
        service.from("mail_watch_seen").select("message_id").eq("user_id", user.id).order("at", { ascending: false }).limit(300),
        service.from("mail_watch_events").select("bot_id, data, at").eq("user_id", user.id).gt("at", since).order("at", { ascending: true }).limit(50),
      ]);
      return json({
        success: true, enabled: acc.enabled, cursor: acc.cloud_cursor, lastCheck: acc.last_check, lastError: acc.last_error,
        seen: (seen ?? []).map((r) => r.message_id),
        events: (events ?? []).map((r) => ({ ...(r.data as Record<string, unknown>), botId: r.bot_id, at: Date.parse(r.at) })),
      });
    }

    return json({ success: false, error: "Unknown action." }, 400);
  } catch (e) {
    console.error("[mail-watch]", String((e as Error)?.message ?? e).slice(0, 300));
    return json({ success: false, error: "Could not save that. Try again." }, 500);
  }
});
