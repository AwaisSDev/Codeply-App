// Codeply: models synced from Craft to the phone.
//
//   POST { action: "list" }
//        -> { success, models: [{ id, clientId, name, kind, baseUrl, model, key, updatedAt }] }
//           metadata only; `key` is masked ("****abcd"). Keys never come back.
//   POST { action: "upsert", model: { clientId, name, kind, baseUrl, model, apiKey? } }
//        -> { success, model }   apiKey is accepted once, over TLS, with the
//           user's JWT, sealed here (functions/_shared/model-keys.ts) and
//           dropped. Leaving apiKey out keeps the saved key (same base URL only).
//   POST { action: "delete", clientId }  -> { success }
//
// Only OpenAI-compatible models with a key are accepted: a ChatGPT plan
// sign-in stays on the PC, and Ollama runs on the PC.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { keyLast4, maskedKey, parseKekRing, sealKey, type SealedKey } from "../_shared/model-keys.ts";
import { checkBaseUrl, checkResolvedHost } from "../_shared/url-guard.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_MODELS = 25;
const MAX_BODY = 16_000;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

type Row = {
  id: string; client_id: string; name: string; kind: string; base_url: string; model: string;
  key_last4: string; key_version: number; updated_at: string;
};

function publicRow(r: Row) {
  return {
    id: r.id, clientId: r.client_id, name: r.name, kind: r.kind, baseUrl: r.base_url, model: r.model,
    key: maskedKey(r.key_last4), updatedAt: r.updated_at,
  };
}

const resolver = typeof Deno.resolveDns === "function"
  ? (host: string, type: "A" | "AAAA") => Deno.resolveDns(host, type)
  : null;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in first." }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ success: false, error: "Sign in first." }, 401);

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ success: false, error: "Request too large." }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { return json({ success: false, error: "Invalid JSON." }, 400); }
    const action = String(body.action || "");

    // ── List ────────────────────────────────────────────────────────────────
    if (action === "list") {
      if (!(await hit(supabase, "list", 120, 3600))) return limited();
      const { data, error } = await supabase
        .from("user_models")
        .select("id, client_id, name, kind, base_url, model, key_last4, key_version, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return json({ success: true, models: (data as Row[] || []).map(publicRow) });
    }

    // ── Delete ──────────────────────────────────────────────────────────────
    if (action === "delete") {
      if (!(await hit(supabase, "write", 60, 3600))) return limited();
      const clientId = String(body.clientId || "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) return json({ success: false, error: "Unknown model." }, 400);
      // The secret row goes with it (on delete cascade).
      const { error } = await supabase.from("user_models").delete().eq("client_id", clientId).eq("user_id", user.id);
      if (error) throw error;
      return json({ success: true });
    }

    // ── Upsert ──────────────────────────────────────────────────────────────
    if (action === "upsert") {
      if (!(await hit(supabase, "write", 60, 3600))) return limited();
      const m = (body.model || {}) as Record<string, unknown>;
      const clientId = String(m.clientId || "");
      const kind = String(m.kind || "openai");
      const model = String(m.model || "").trim();
      const name = (String(m.name || "").trim() || model).slice(0, 80);
      const hasKey = typeof m.apiKey === "string" && m.apiKey !== "";
      const apiKey = hasKey ? String(m.apiKey).trim() : "";

      if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) return json({ success: false, error: "Invalid model id." }, 400);
      if (kind === "chatgpt") return json({ success: false, error: "ChatGPT plan models stay on your PC: the ChatGPT sign-in is never uploaded." }, 400);
      if (kind === "ollama") return json({ success: false, error: "Ollama runs on your PC, so the phone uses it through the PC." }, 400);
      if (kind !== "openai") return json({ success: false, error: "Unsupported model type." }, 400);
      if (!model || model.length > 200) return json({ success: false, error: "Enter the model id." }, 400);
      if (hasKey && (apiKey.length < 8 || apiKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(apiKey))) {
        return json({ success: false, error: "That API key does not look right." }, 400);
      }

      const url = checkBaseUrl(String(m.baseUrl || ""));
      if (!url.ok) return json({ success: false, error: url.error }, 400);
      const resolved = await checkResolvedHost(url.host, resolver);
      if (resolved && !resolved.ok) return json({ success: false, error: resolved.error }, 400);

      const { data: existing, error: exErr } = await supabase
        .from("user_models")
        .select("id, base_url, key_version")
        .eq("client_id", clientId)
        .maybeSingle();
      if (exErr) throw exErr;

      if (!existing) {
        const { count, error: cErr } = await supabase.from("user_models").select("id", { count: "exact", head: true });
        if (cErr) throw cErr;
        if ((count ?? 0) >= MAX_MODELS) return json({ success: false, error: `You can sync up to ${MAX_MODELS} models.` }, 400);
        if (!hasKey) return json({ success: false, error: "Send the API key once to sync this model." }, 400);
      } else if (!hasKey && existing.base_url !== url.url) {
        return json({ success: false, error: "The base URL changed, so the API key has to be sent again." }, 400);
      }

      const id: string = existing?.id ?? crypto.randomUUID();
      const expected: number = existing?.key_version ?? 0;
      const keyVersion = hasKey ? expected + 1 : expected;

      let secret: SealedKey | null = null;
      let last4: string | undefined;
      if (hasKey) {
        const ring = parseKekRing(Deno.env.get("MODEL_KEYS_KEK") ?? "");
        secret = await sealKey(ring, { userId: user.id, modelId: id, keyVersion, baseUrl: url.url }, apiKey);
        last4 = keyLast4(apiKey);
      }
      if (last4 === undefined) {
        const { data: cur } = await supabase.from("user_models").select("key_last4").eq("id", id).maybeSingle();
        last4 = cur?.key_last4 ?? "";
      }

      const { data: saved, error: saveErr } = await serviceClient().rpc("user_model_save", {
        p_user_id: user.id, p_id: id, p_client_id: clientId, p_name: name, p_kind: kind,
        p_base_url: url.url, p_model: model, p_key_last4: last4, p_key_version: keyVersion,
        p_expected_version: expected, p_secret: secret,
      });
      if (saveErr) {
        if (/user_model_conflict/.test(saveErr.message)) return json({ success: false, error: "This model changed at the same time somewhere else. Try again.", retry: true }, 409);
        if (/user_model_no_key/.test(saveErr.message)) return json({ success: false, error: "Send the API key once to sync this model." }, 400);
        throw new Error("Could not save the model.");
      }
      return json({ success: true, model: publicRow(saved as Row) });
    }

    return json({ success: false, error: "Unknown action." }, 400);
  } catch (e: unknown) {
    // Never the request body: it may hold a key.
    console.error("[user-models]", e instanceof Error ? e.message : "error");
    return json({ success: false, error: "Something went wrong saving your model. Try again." }, 500);
  }
});

async function hit(supabase: ReturnType<typeof createClient>, action: string, limit: number, windowSeconds: number) {
  const { data, error } = await supabase.rpc("user_models_hit", { p_action: action, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new Error("rate limit check failed");
  return data === true;
}

function limited() {
  return json({ success: false, error: "Too many requests. Wait a little and try again." }, 429);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
