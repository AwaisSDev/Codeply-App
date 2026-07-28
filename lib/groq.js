/**
 * Codeply — AI engine client
 *
 * The app never holds a Groq/OpenRouter key itself — every AI call is
 * proxied through the 'ai-proxy' Supabase Edge Function (see
 * supabase/functions/ai-proxy/index.ts), authenticated with the signed-in
 * user's session token. This is what makes a DOWNLOADED build of the app
 * plug-and-play without shipping a real secret inside the binary: a key
 * embedded in a distributed Electron app can always be extracted, but a key
 * that never leaves the server can't be.
 *
 * isConfigured() reflects "is there a signed-in session right now", not "is
 * a key present" — main.js feeds the current session in via setSession()
 * whenever Supabase's auth state changes (sign-in, sign-out, token refresh),
 * so this stays accurate without an async round-trip on every check.
 */
const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';
const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-proxy`;

let cachedSession = null;

/** Called by main.js on every Supabase auth-state change (including token refresh). */
function setSession(session) {
  cachedSession = session || null;
}

function isConfigured() {
  return !!cachedSession;
}

// A rate-limit / quota error means the shared key genuinely can't answer
// right now. Kept here (not just server-side) so callers that want to
// short-circuit their own retry loops on a doomed request still can.
function isRateLimitError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('rate limit') || s.includes('429') || s.includes('tokens per day')
    || s.includes('tokens per minute') || s.includes(' tpd') || s.includes(' tpm')
    || s.includes('quota') || s.includes('daily ai request limit');
}

/**
 * Send a chat completion through the ai-proxy edge function.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ json?: boolean, maxTokens?: number, temperature?: number, meta?: {promptText?: string, filePath?: string} }} opts
 *        `meta` is optional, display-only context (what was asked, which file) the proxy logs to
 *        usage_history for the admin dashboard — it never affects the actual AI call.
 * @returns {Promise<{success:boolean, data?:object, error?:string, modelUsed?:string}>}
 *          `data` is the raw OpenAI-compatible response body.
 */
async function chat(messages, opts = {}) {
  if (!cachedSession) return { success: false, error: 'Sign in to use AI features.' };

  try {
    const res = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cachedSession.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ messages, opts, meta: opts.meta }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
      return { success: false, error: body.error || `HTTP ${res.status}` };
    }
    return { success: true, data: body.data, modelUsed: body.modelUsed };
  } catch (e) {
    // Network down, DNS failure, etc.
    console.warn('[ai-proxy] request threw:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Chat helper that expects a JSON object back and parses it.
 * Returns { success, json, usage, error }.
 */
async function chatJson(messages, opts = {}) {
  const r = await chat(messages, { ...opts, json: true });
  if (!r.success) return { success: false, error: r.error };
  let parsed = null;
  try { parsed = JSON.parse(r.data.choices[0].message.content); }
  catch { return { success: false, error: 'AI returned an unreadable response.' }; }
  return { success: true, json: parsed, usage: r.data.usage || {}, modelUsed: r.modelUsed };
}

module.exports = { setSession, isConfigured, chat, chatJson, isRateLimitError };
