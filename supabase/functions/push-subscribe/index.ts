// Codeply: saves the phone's Web Push subscription so reminders-tick can
// reach it (the user's bots remind them and "call" them).
//
// POST { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }  save (or move to this user)
// POST { action: "delete", endpoint }                                    forget it
// GET                                                                     { publicKey } (the VAPID public key)
// Deployed with --no-verify-jwt: the user's token is checked here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const MAX_PER_USER = 10;
// Only the browsers' own push services: nothing else is ever sent a request.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /^android\.googleapis\.com$/];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function validEndpoint(s: unknown): string | null {
  if (typeof s !== "string" || s.length > 1000) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname)) ? u.toString() : null;
  } catch { return null; }
}
const b64url = (s: unknown, min: number, max: number) => typeof s === "string" && s.length >= min && s.length <= max && /^[A-Za-z0-9_-]+=*$/.test(s);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method === "GET") return json({ success: true, publicKey: VAPID_PUBLIC_KEY });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ success: false, error: "Sign in to get reminders." }, 401);
  const { data: { user } = { user: null }, error: authErr } = await service.auth.getUser(token);
  if (authErr || !user) return json({ success: false, error: "Sign in to get reminders." }, 401);
  const body = await req.json().catch(() => ({}));

  if (body?.action === "delete") {
    if (typeof body.endpoint !== "string") return json({ success: false, error: "endpoint required." }, 400);
    await service.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", body.endpoint);
    return json({ success: true });
  }

  const sub = body?.subscription ?? {};
  const endpoint = validEndpoint(sub.endpoint);
  if (!endpoint) return json({ success: false, error: "That is not a browser push address." }, 400);
  const keys = sub.keys ?? {};
  if (!b64url(keys.p256dh, 80, 100) || !b64url(keys.auth, 16, 32)) return json({ success: false, error: "Subscription keys are missing." }, 400);

  // One row per endpoint; a phone that changed accounts moves to this user.
  const { error } = await service.from("push_subscriptions").upsert({
    user_id: user.id, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth },
    user_agent: String(body?.userAgent ?? req.headers.get("user-agent") ?? "").slice(0, 300),
  }, { onConflict: "endpoint" });
  if (error) return json({ success: false, error: "Could not save this phone." }, 500);

  // Keep the newest few per user.
  const { data: all } = await service.from("push_subscriptions").select("id").eq("user_id", user.id).order("created_at", { ascending: false });
  const extra = (all ?? []).slice(MAX_PER_USER).map((r) => r.id);
  if (extra.length) await service.from("push_subscriptions").delete().in("id", extra);
  return json({ success: true });
});
