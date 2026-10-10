// Codeply: chat with a model the user synced from Craft, using their own key.
//
//   POST { modelId, messages, opts?: { temperature?, maxTokens? }, stream? }
//
// Loads the caller's user_models row (RLS, their JWT) and its sealed key
// (service role), decrypts the key here, in memory, for this one request, and
// calls the model's own OpenAI-compatible /chat/completions. The key is never
// returned, logged or stored in the clear.
//
// The reply has the same shape as ai-proxy's, so the phone reads both alike:
//   { success: true, data: <chat.completion>, modelUsed }
//   { success: false, error }
// With stream: true the provider's SSE stream (chat.completion.chunk lines) is
// passed through as text/event-stream instead.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { inboxContext, MAIL_TALK } from "../_shared/gmail-lookup.ts";

/**
 * Chat from the phone (opts.inbox): when the latest message is about email,
 * read the user's Gmail (the link they turned on for calls) and put what was
 * found just before that message, the same way calls do. Never fails the chat.
 */
async function withInbox(messages: Array<{ role: string; content: unknown }>, userId: string, opts: Record<string, unknown> | undefined) {
  if (!opts || opts.inbox !== true) return messages;
  const users = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? ""));
  const last = users[users.length - 1] ?? "";
  if (!MAIL_TALK.test(last)) return messages;
  const inbox = await inboxContext(userId, users.slice(-3).join("\n"), String(opts.tz ?? "UTC")).catch(() => null);
  if (!inbox) return messages;
  const out = messages.slice();
  out.splice(out.length - 1, 0, { role: "system", content: inbox });
  return out;
}
import { needsRewrap, openKey, parseKekRing, rewrapKey, scrubKey, type SealedKey } from "../_shared/model-keys.ts";
import { checkBaseUrl, checkResolvedHost } from "../_shared/url-guard.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BODY = 400_000;
const MAX_MESSAGES = 100;
const TIMEOUT_MS = 120_000;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const resolver = typeof Deno.resolveDns === "function"
  ? (host: string, type: "A" | "AAAA") => Deno.resolveDns(host, type)
  : null;

function serviceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function cleanMessages(input: unknown): { role: string; content: unknown }[] | null {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MESSAGES) return null;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== "object") return null;
    const role = String((m as Record<string, unknown>).role || "");
    const content = (m as Record<string, unknown>).content;
    if (!["system", "user", "assistant"].includes(role)) return null;
    if (typeof content !== "string" && !Array.isArray(content)) return null;
    out.push({ role, content });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "POST only." }, 405);

  let apiKey = "";
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Sign in to use your models." }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth:   { persistSession: false },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return json({ success: false, error: "Sign in to use your models." }, 401);

    // Per minute against bursts, per day against a leaked session burning a key.
    if (!(await hit(supabase, "chat_min", 20, 60)) || !(await hit(supabase, "chat_day", 1000, 86400))) {
      return json({ success: false, error: "Too many requests. Wait a little and try again." }, 429);
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ success: false, error: "That conversation is too long to send." }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}"); } catch { return json({ success: false, error: "Invalid JSON." }, 400); }

    const modelId = String(body.modelId || "");
    if (!/^[0-9a-f-]{36}$/i.test(modelId)) return json({ success: false, error: "Pick a synced model." }, 400);
    const cleaned = cleanMessages(body.messages);
    if (!cleaned) return json({ success: false, error: "messages[] required" }, 400);
    const opts = (body.opts || {}) as Record<string, unknown>;
    const messages = await withInbox(cleaned, user.id, opts);
    const stream = body.stream === true;

    // The caller's own row (RLS), then its sealed key (service role, same user).
    const { data: row, error: rowErr } = await supabase
      .from("user_models")
      .select("id, user_id, name, kind, base_url, model, key_version")
      .eq("id", modelId)
      .maybeSingle();
    if (rowErr) throw new Error("model lookup failed");
    if (!row || row.user_id !== user.id) return json({ success: false, error: "That model is no longer synced. Sync it again from Craft on your PC." }, 404);

    const url = checkBaseUrl(row.base_url);
    if (!url.ok) return json({ success: false, error: url.error }, 400);
    const resolved = await checkResolvedHost(url.host, resolver);
    if (resolved && !resolved.ok) return json({ success: false, error: resolved.error }, 400);

    const svc = serviceClient();
    const { data: secret, error: secErr } = await svc
      .from("user_model_secrets")
      .select("kek_version, dek_iv, wrapped_dek, key_iv, key_ciphertext")
      .eq("model_id", row.id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (secErr) throw new Error("key lookup failed");
    if (!secret) return json({ success: false, error: "That model has no saved key. Sync it again from Craft on your PC." }, 404);

    const ring = parseKekRing(Deno.env.get("MODEL_KEYS_KEK") ?? "");
    const ctx = { userId: user.id, modelId: row.id, keyVersion: row.key_version, baseUrl: row.base_url };
    try { apiKey = await openKey(ring, ctx, secret as SealedKey); }
    catch { return json({ success: false, error: "That model's key could not be unlocked. Sync it again from Craft on your PC." }, 409); }

    // Rotation: a row wrapped with an older KEK is re-wrapped with the current one.
    if (needsRewrap(ring, secret as SealedKey)) {
      try {
        const next = await rewrapKey(ring, ctx, secret as SealedKey);
        await svc.from("user_model_secrets")
          .update({ kek_version: next.kek_version, dek_iv: next.dek_iv, wrapped_dek: next.wrapped_dek, updated_at: new Date().toISOString() })
          .eq("model_id", row.id).eq("kek_version", (secret as SealedKey).kek_version);
      } catch { console.warn("[byok-proxy] rewrap skipped"); }
    }

    const temperature = typeof opts.temperature === "number" ? Math.min(2, Math.max(0, opts.temperature)) : undefined;
    const maxTokens = typeof opts.maxTokens === "number" ? Math.min(32_000, Math.max(1, Math.floor(opts.maxTokens))) : undefined;

    let res: Response;
    try {
      res = await fetch(`${url.url}/chat/completions`, {
        method: "POST",
        redirect: "manual", // a redirect could point the key at another host
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "Accept": stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify({
          model: row.model,
          messages,
          stream,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
      });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      return json({ success: false, error: timedOut ? `${row.name} took too long to answer.` : `Could not reach ${url.host}.` }, 502);
    }

    if (res.status >= 300 && res.status < 400) {
      return json({ success: false, error: `${url.host} tried to redirect the request, which is not allowed. Check the base URL in Craft.` }, 502);
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = (data && (data.error?.message || data.error?.code || data.message)) || `HTTP ${res.status}`;
      return json({ success: false, error: scrubKey(`${row.name}: ${String(msg).slice(0, 400)}`, apiKey) }, res.status === 429 ? 429 : 502);
    }

    if (stream && res.body) {
      return new Response(res.body, {
        status: 200,
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
      });
    }

    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
      return json({ success: false, error: `${row.name} sent back a reply Codeply could not read.` }, 502);
    }
    return json({ success: true, data, modelUsed: row.name });
  } catch (e: unknown) {
    // Only our own message, scrubbed: never the body, never the key.
    console.error("[byok-proxy]", scrubKey(e instanceof Error ? e.message : "error", apiKey));
    return json({ success: false, error: "Something went wrong reaching your model. Try again." }, 500);
  } finally {
    apiKey = "";
  }
});

async function hit(supabase: ReturnType<typeof createClient>, action: string, limit: number, windowSeconds: number) {
  const { data, error } = await supabase.rpc("user_models_hit", { p_action: action, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw new Error("rate limit check failed");
  return data === true;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
