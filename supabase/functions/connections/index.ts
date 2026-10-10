// Codeply: the user's connected apps (Gmail, Slack, Vercel, Supabase, GitHub)
// for Codeply Cloud runs. Stored encrypted (AES-GCM, server-only key
// CONNECTIONS_KEY) in public.user_connections. Deployed with --no-verify-jwt:
// the caller is checked here.
//
//   POST { action: "save", connections: { gmail: {...}, ... } }   user token
//        replaces the stored set (a provider left out is removed)
//   POST { action: "clear" }                                     user token
//   POST { action: "get" }    user token, or x-codeply-track-key (a cloud run)
//        -> { connections: { gmail: {...}, ... } }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-codeply-track-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const PROVIDERS = ["gmail", "slack", "vercel", "supabase", "github"];
const MAX_BYTES = 16_000; // per provider, after JSON

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let keyPromise: Promise<CryptoKey> | null = null;
function aesKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = Uint8Array.from(atob(Deno.env.get("CONNECTIONS_KEY") ?? ""), (c) => c.charCodeAt(0));
    if (raw.length !== 32) throw new Error("CONNECTIONS_KEY must be 32 bytes, base64");
    keyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return keyPromise;
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
async function seal(value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(), new TextEncoder().encode(JSON.stringify(value))));
  return b64(iv) + "." + b64(ct);
}
async function open(sealed: string, aad: string): Promise<unknown> {
  const [iv, ct] = sealed.split(".").map((p) => Uint8Array.from(atob(p), (c) => c.charCodeAt(0)));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(), ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Only the fields a connection needs: strings and numbers, nothing nested. */
function clean(v: unknown): Record<string, string | number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (typeof x === "string") out[k] = x.slice(0, 4000);
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  if (!out.accessToken) return null; // not connected
  return JSON.stringify(out).length <= MAX_BYTES ? out : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const body = await req.json().catch(() => ({}));

  let userId: string | null = null;
  const trackKey = (req.headers.get("x-codeply-track-key") ?? "").trim();
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (trackKey) {
    if (/^cpt_[A-Za-z0-9_-]{30,80}$/.test(trackKey)) {
      const { data } = await service.from("track_keys").select("user_id").eq("key_hash", await sha256(trackKey)).maybeSingle();
      userId = (data?.user_id as string) ?? null;
    }
  } else if (token) {
    const { data: { user } } = await service.auth.getUser(token);
    userId = user?.id ?? null;
  }
  if (!userId) return json({ success: false, error: "Sign in first." }, 401);

  try {
    if (body?.action === "get") {
      const { data } = await service.from("user_connections").select("provider,data").eq("user_id", userId);
      const connections: Record<string, unknown> = {};
      for (const row of data ?? []) {
        try { connections[row.provider] = await open(row.data, `${userId}:${row.provider}`); } catch { /* key changed: skip */ }
      }
      return json({ success: true, connections });
    }
    // Writing needs the user's own sign-in, never a usage key.
    if (trackKey) return json({ success: false, error: "Sign in first." }, 401);
    if (body?.action === "clear") {
      await service.from("user_connections").delete().eq("user_id", userId);
      return json({ success: true });
    }
    if (body?.action === "save") {
      const given = body?.connections && typeof body.connections === "object" ? body.connections : {};
      const rows = [];
      for (const p of PROVIDERS) {
        const c = clean(given[p]);
        if (c) rows.push({ user_id: userId, provider: p, data: await seal(c, `${userId}:${p}`), updated_at: new Date().toISOString() });
      }
      const keep = rows.map((r) => r.provider);
      // drop the ones no longer connected, then write the rest
      let del = service.from("user_connections").delete().eq("user_id", userId);
      if (keep.length) del = del.not("provider", "in", `(${keep.join(",")})`);
      await del;
      if (rows.length) {
        const { error } = await service.from("user_connections").upsert(rows, { onConflict: "user_id,provider" });
        if (error) return json({ success: false, error: "Could not save connections." }, 500);
      }
      return json({ success: true, saved: keep });
    }
    return json({ success: false, error: "Unknown action." }, 400);
  } catch (e) {
    console.error("connections", e);
    return json({ success: false, error: "Connections are not available right now." }, 500);
  }
});
