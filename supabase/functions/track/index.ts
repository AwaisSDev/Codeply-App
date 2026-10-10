// Codeply: usage counts from the apps (Craft, Crew, the CLI, Cloud runs) for the
// admin dashboard. POST { events: [...] }; up to 100 events per request, each
// { product, kind, model, provider, tokens_in, tokens_out, ms, version,
// platform, at }. Counts only, never content. Deployed with --no-verify-jwt:
// the caller is checked here.
//
// Who is calling:
//   Authorization: Bearer <user token>      the desktop apps and the CLI
//   x-codeply-track-key: <usage key>        Cloud runs inside GitHub Actions,
//                                           which have no Codeply sign-in
// POST { action: "mint" } with a user token creates a usage key for that user
// (Craft puts it in the Cloud repo's encrypted secrets). Only its SHA-256 is kept.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-codeply-track-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const PRODUCTS = ["craft", "crew", "cli", "drop", "phone", "cloud"];
const KINDS = ["ai", "open"];
const PROVIDERS = ["auto", "byok", "proxy", "ollama", "chatgpt", "research"];
const str = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const int = (v: unknown, max: number) => { const n = Math.round(Number(v) || 0); return Math.max(0, Math.min(max, n)); };
const MAX_KEYS_PER_USER = 50;

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The user behind a usage key, or null. */
async function userFromKey(key: string): Promise<string | null> {
  if (!/^cpt_[A-Za-z0-9_-]{30,80}$/.test(key)) return null;
  const hash = await sha256(key);
  const { data } = await service.from("track_keys").select("user_id").eq("key_hash", hash).maybeSingle();
  if (!data) return null;
  await service.from("track_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", hash);
  return data.user_id as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const body = await req.json().catch(() => ({}));

  let userId: string | null = null;
  const trackKey = (req.headers.get("x-codeply-track-key") ?? "").trim();
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (trackKey) {
    userId = await userFromKey(trackKey);
  } else if (token) {
    const { data: { user } } = await service.auth.getUser(token);
    userId = user?.id ?? null;
  }
  if (!userId) return json({ success: false, error: "Sign in first." }, 401);

  // A new usage key for Cloud runs (signed-in users only, never with a usage key).
  if (body?.action === "mint") {
    if (trackKey) return json({ success: false, error: "Sign in first." }, 401);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = "cpt_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const { count } = await service.from("track_keys").select("key_hash", { count: "exact", head: true }).eq("user_id", userId);
    if ((count ?? 0) >= MAX_KEYS_PER_USER) {
      // keep the newest ones: drop the oldest before adding
      const { data: old } = await service.from("track_keys").select("key_hash").eq("user_id", userId).order("created_at", { ascending: true }).limit((count ?? 0) - MAX_KEYS_PER_USER + 1);
      if (old?.length) await service.from("track_keys").delete().in("key_hash", old.map((o) => o.key_hash));
    }
    const { error } = await service.from("track_keys").insert({ key_hash: await sha256(key), user_id: userId, label: str(body?.label, 120) });
    if (error) return json({ success: false, error: "Could not create a usage key." }, 500);
    return json({ success: true, key });
  }

  const now = Date.now();
  // deno-lint-ignore no-explicit-any
  const rows = (Array.isArray(body?.events) ? body.events : []).slice(0, 100).map((e: any) => {
    const at = Date.parse(String(e?.at ?? ""));
    return {
      user_id: userId,
      // a usage key is only ever handed to Cloud runs, so its events are Cloud's
      product: trackKey ? "cloud" : PRODUCTS.includes(e?.product) ? e.product : null,
      kind: KINDS.includes(e?.kind) ? e.kind : "ai",
      model: str(e?.model, 120),
      provider: PROVIDERS.includes(e?.provider) ? e.provider : null,
      tokens_in: int(e?.tokens_in, 2_000_000),
      tokens_out: int(e?.tokens_out, 500_000),
      ms: e?.ms == null ? null : int(e.ms, 3_600_000),
      version: str(e?.version, 30),
      platform: str(e?.platform, 20),
      // A queued event keeps its own time (up to a week back); otherwise now.
      created_at: new Date(Number.isFinite(at) && at <= now && now - at < 7 * 86400_000 ? at : now).toISOString(),
    };
  }).filter((r: { product: string | null }) => r.product);
  if (!rows.length) return json({ success: true, stored: 0 });
  const { error } = await service.from("app_events").insert(rows);
  if (error) return json({ success: false, error: "Could not store usage." }, 500);
  return json({ success: true, stored: rows.length });
});
