// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MASTER_SECRET   = Deno.env.get("API_KEY_MASTER_SECRET") ?? "";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── AES-256-GCM ───────────────────────────────────────────────────────────────

async function getKey(): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(
    MASTER_SECRET.slice(0, 32).padEnd(32, "0")
  );
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(buf: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf.buffer : buf)));
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const key = await getKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `v2:${toB64(iv)}:${toB64(enc)}`;
}

async function decrypt(stored: string): Promise<string> {
  if (!stored || !stored.startsWith("v2:")) return "";
  const [, ivB64, encB64] = stored.split(":");
  const key = await getKey();
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(encB64));
  return new TextDecoder().decode(dec);
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    if (!MASTER_SECRET) throw new Error("API_KEY_MASTER_SECRET not set");

    // Extract JWT from Authorization header
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    // Build a Supabase client for RLS
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });

    // Pass token explicitly — getUser() without args ignores global.headers
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { action, api_key, provider, model, token_cap, model_ranking } = await req.json();

    // ── Save ──────────────────────────────────────────────────────────────────
    if (action === "save") {
      const ciphertext = await encrypt(api_key || "");

      // Encrypt the entire model_ranking array as a JSON blob
      let encryptedRanking: string | null = null;
      if (Array.isArray(model_ranking) && model_ranking.length > 0) {
        encryptedRanking = await encrypt(JSON.stringify(model_ranking));
      }

      const { error } = await supabase.from("user_settings").upsert({
        user_id:       user.id,
        api_key:       ciphertext,
        model_ranking: encryptedRanking,
        provider:      provider  ?? "openrouter",
        model:         model     ?? "",
        token_cap:     token_cap ?? 0,
        updated_at:    new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (error) throw error;
      return json({ success: true });

    // ── Get ───────────────────────────────────────────────────────────────────
    } else if (action === "get") {
      const { data, error } = await supabase
        .from("user_settings")
        .select("api_key, provider, model, token_cap, model_ranking")
        .eq("user_id", user.id)
        .single();

      if (error || !data) return json({ api_key: "", provider: "openrouter", model: "", token_cap: 0, model_ranking: [] });

      // Decrypt model_ranking JSON blob
      let rankingArr: unknown[] = [];
      try {
        const dec = data.model_ranking ? await decrypt(data.model_ranking) : null;
        if (dec) rankingArr = JSON.parse(dec);
      } catch { /* malformed — return empty */ }

      return json({
        api_key:       await decrypt(data.api_key || ""),
        provider:      data.provider,
        model:         data.model,
        token_cap:     data.token_cap,
        model_ranking: rankingArr,
      });
    }

    return json({ error: "Unknown action" }, 400);

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api-key]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
