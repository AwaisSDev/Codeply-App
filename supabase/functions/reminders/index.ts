// Codeply: reminders the user's bots set (the phone app).
//
// POST JSON { action, ... } with the user's token (Authorization: Bearer):
//   list                          upcoming reminders (pending or snoozed), soonest first
//   get     { id }                one reminder (any status)
//   create  { reminder }          { text, due_at, kind?, repeat?, bot_id?, bot_name?, bot_voice?, tz?, payload? }
//   update  { id, patch }         text, due_at, kind, repeat, status, payload
//   delete  { id }
//   snooze  { id, minutes? }      due again in N minutes (default 10)
// The notification's own "Snooze" button has no sign-in: it sends
//   snooze { id, key, minutes? }  where key is the reminder's action_key from the push.
// Deployed with --no-verify-jwt: the token is checked here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_PENDING = 200;
const KINDS = ["remind", "call", "task"];
const REPEATS = ["daily", "weekdays", "weekly"];
const STATUSES = ["pending", "sent", "done", "snoozed"];
const FIELDS = "id, bot_id, bot_name, bot_voice, text, due_at, tz, repeat, kind, payload, status, sent_at, created_at";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const str = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** A due time from the phone: a real date, not long past, at most a year ahead. */
function dueAt(v: unknown): string | { error: string } {
  const t = Date.parse(String(v ?? ""));
  if (!Number.isFinite(t)) return { error: "due_at must be an ISO 8601 date and time." };
  const now = Date.now();
  if (t < now - 5 * 60_000) return { error: "That time has already passed." };
  if (t > now + 366 * 86_400_000) return { error: "Reminders can be set up to a year ahead." };
  return new Date(Math.max(t, now)).toISOString();
}
function validTz(v: unknown): string | null {
  const s = str(v, 64);
  if (!s) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return null; }
}
function payloadOf(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const s = JSON.stringify(v);
  return s.length > 4000 ? {} : v as Record<string, unknown>;
}

/**
 * Due again in N minutes. A repeating reminder keeps its series (the sender has
 * already moved it to its next time): the snooze is a one-off copy instead.
 */
async function snoozeRow(row: Record<string, unknown>, minutes: number) {
  const due_at = new Date(Date.now() + minutes * 60_000).toISOString();
  if (row.repeat) {
    const { id: _id, action_key: _k, sent_at: _s, created_at: _c, ...rest } = row;
    return await service.from("reminders").insert({ ...rest, repeat: null, status: "snoozed", due_at }).select(FIELDS).single();
  }
  return await service.from("reminders").update({ status: "snoozed", due_at }).eq("id", row.id).select(FIELDS).single();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return new Response(null, { status: 204, headers: CORS }); // wake-up ping
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const minutes = Math.min(24 * 60, Math.max(1, Math.round(Number(body?.minutes) || 10)));

  // Snooze from the notification itself: the reminder's own key instead of a sign-in.
  if (action === "snooze" && typeof body?.key === "string" && !req.headers.get("Authorization")) {
    if (!isUuid(body.id) || !/^[0-9a-f]{32}$/.test(body.key)) return json({ success: false, error: "Bad request." }, 400);
    const { data: row } = await service.from("reminders").select("*").eq("id", body.id).eq("action_key", body.key).maybeSingle();
    if (!row) return json({ success: false, error: "Not found." }, 404);
    const { data, error } = await snoozeRow(row, minutes);
    if (error || !data) return json({ success: false, error: "Could not snooze." }, 500);
    return json({ success: true, reminder: { id: data.id, due_at: data.due_at } });
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ success: false, error: "Sign in to use reminders." }, 401);
  const { data: { user } = { user: null }, error: authErr } = await service.auth.getUser(token);
  if (authErr || !user) return json({ success: false, error: "Sign in to use reminders." }, 401);
  const mine = () => service.from("reminders");

  switch (action) {
    case "list": {
      const { data, error } = await mine().select(FIELDS).eq("user_id", user.id)
        .in("status", ["pending", "snoozed"]).order("due_at", { ascending: true }).limit(100);
      if (error) return json({ success: false, error: "Could not load reminders." }, 500);
      return json({ success: true, reminders: data });
    }
    case "get": {
      if (!isUuid(body.id)) return json({ success: false, error: "id required." }, 400);
      const { data } = await mine().select(FIELDS).eq("user_id", user.id).eq("id", body.id).maybeSingle();
      if (!data) return json({ success: false, error: "Not found." }, 404);
      return json({ success: true, reminder: data });
    }
    case "create": {
      const r = body.reminder ?? {};
      const text = str(r.text, 500);
      if (!text) return json({ success: false, error: "text required." }, 400);
      const due = dueAt(r.due_at);
      if (typeof due !== "string") return json({ success: false, error: due.error }, 400);
      const { count } = await mine().select("id", { count: "exact", head: true }).eq("user_id", user.id).in("status", ["pending", "snoozed"]);
      if ((count ?? 0) >= MAX_PENDING) return json({ success: false, error: `You have ${MAX_PENDING} reminders waiting. Delete some first.` }, 429);
      const row = {
        user_id: user.id, text, due_at: due,
        kind: KINDS.includes(r.kind) ? r.kind : "remind",
        repeat: REPEATS.includes(r.repeat) ? r.repeat : null,
        bot_id: str(r.bot_id, 120), bot_name: str(r.bot_name, 60) ?? "Codeply", bot_voice: str(r.bot_voice, 60),
        tz: validTz(r.tz), payload: payloadOf(r.payload), status: "pending",
      };
      const { data, error } = await mine().insert(row).select(FIELDS).single();
      if (error) return json({ success: false, error: "Could not save the reminder." }, 500);
      return json({ success: true, reminder: data });
    }
    case "update": {
      if (!isUuid(body.id)) return json({ success: false, error: "id required." }, 400);
      const p = body.patch ?? {};
      const patch: Record<string, unknown> = {};
      if (p.text != null) { const t = str(p.text, 500); if (!t) return json({ success: false, error: "text required." }, 400); patch.text = t; }
      if (p.due_at != null) { const d = dueAt(p.due_at); if (typeof d !== "string") return json({ success: false, error: d.error }, 400); patch.due_at = d; }
      if (p.kind != null && KINDS.includes(p.kind)) patch.kind = p.kind;
      if ("repeat" in p) patch.repeat = REPEATS.includes(p.repeat) ? p.repeat : null;
      if (p.status != null && STATUSES.includes(p.status)) patch.status = p.status;
      if (p.payload != null) patch.payload = payloadOf(p.payload);
      if (!Object.keys(patch).length) return json({ success: false, error: "Nothing to change." }, 400);
      const { data, error } = await mine().update(patch).eq("user_id", user.id).eq("id", body.id).select(FIELDS).maybeSingle();
      if (error) return json({ success: false, error: "Could not update the reminder." }, 500);
      if (!data) return json({ success: false, error: "Not found." }, 404);
      return json({ success: true, reminder: data });
    }
    case "snooze": {
      if (!isUuid(body.id)) return json({ success: false, error: "id required." }, 400);
      const { data: row } = await mine().select("*").eq("user_id", user.id).eq("id", body.id).maybeSingle();
      if (!row) return json({ success: false, error: "Not found." }, 404);
      const { data, error } = await snoozeRow(row, minutes);
      if (error || !data) return json({ success: false, error: "Could not snooze." }, 500);
      return json({ success: true, reminder: data });
    }
    case "delete": {
      if (!isUuid(body.id)) return json({ success: false, error: "id required." }, 400);
      const { error } = await mine().delete().eq("user_id", user.id).eq("id", body.id);
      if (error) return json({ success: false, error: "Could not delete the reminder." }, 500);
      return json({ success: true });
    }
    default:
      return json({ success: false, error: "Unknown action." }, 400);
  }
});
