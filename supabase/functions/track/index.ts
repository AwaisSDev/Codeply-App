// Codeply: usage counts from the apps (Craft, Crew, the CLI) for the admin
// dashboard. POST { events: [...] } with the user's token; up to 100 events
// per request, each { product, kind, model, provider, tokens_in, tokens_out,
// ms, version, platform, at }. Counts only, never content. Deployed with
// --no-verify-jwt: the token is checked here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const PRODUCTS = ["craft", "crew", "cli", "drop", "phone"];
const KINDS = ["ai", "open"];
const PROVIDERS = ["auto", "byok", "proxy", "ollama", "chatgpt", "research"];
const str = (v: unknown, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const int = (v: unknown, max: number) => { const n = Math.round(Number(v) || 0); return Math.max(0, Math.min(max, n)); };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ success: false, error: "Sign in first." }, 401);
  const { data: { user } } = await service.auth.getUser(token);
  if (!user) return json({ success: false, error: "Sign in first." }, 401);
  const body = await req.json().catch(() => ({}));
  const now = Date.now();
  // deno-lint-ignore no-explicit-any
  const rows = (Array.isArray(body?.events) ? body.events : []).slice(0, 100).map((e: any) => {
    const at = Date.parse(String(e?.at ?? ""));
    return {
      user_id: user.id,
      product: PRODUCTS.includes(e?.product) ? e.product : null,
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
