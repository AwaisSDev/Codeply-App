/**
 * Codeply — Groq AI engine (primary provider)
 *
 * The API key is read from the GROQ_API_KEY environment variable ONLY.
 * It is never persisted, never shown in the UI, and never hardcoded.
 * If the key is missing, callers get { success:false } and a developer-facing
 * error is logged to the console — the user is never shown a key error.
 *
 * When Groq is genuinely rate-limited (daily or per-minute quota hit),
 * chat()/chatJson() transparently retry once against OpenRouter's free tier
 * (see lib/openrouter.js) before giving up — every caller gets this for
 * free, there's nothing provider-specific for them to handle.
 */
const fs = require('fs');
const path = require('path');
const openrouter = require('./openrouter');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile was deprecated by Groq on 2026-06-17 for free/dev
// tier. gpt-oss-120b is Groq's recommended replacement, and — unlike the old
// model — it's one of only a few Groq models that support automatic prompt
// caching (see lib/groq.js chat() header comment and main.js's prompt
// ordering: caching only reuses a REPEATED PREFIX of tokens, so callers put
// large/stable content first and the always-different part last).
const GROQ_MODEL = 'openai/gpt-oss-120b';

let warnedMissingKey = false;

// Dev convenience: allow a `.env` file next to the app to populate process.env.
// The value still only ever lives in the environment — never in app config.
function loadDotEnv(appDir) {
  try {
    const envPath = path.join(appDir, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      // Real env always wins over .env
      if (process.env[key] !== undefined) continue;
      process.env[key] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.warn('[Groq] .env load skipped:', e.message);
  }
}

function getApiKey() {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key && !warnedMissingKey) {
    warnedMissingKey = true;
    // Developer-facing only — the user never sees this.
    console.error(
      '[Groq] GROQ_API_KEY is not set. AI features are disabled and Codeply ' +
      'falls back to offline heuristics. Set the GROQ_API_KEY environment ' +
      'variable (or a .env file in the app directory during development).'
    );
  }
  return key || null;
}

function isConfigured() {
  return !!getApiKey();
}

// A rate-limit / quota error means Groq genuinely can't answer right now —
// that's exactly (and ONLY) when the OpenRouter fallback kicks in. Any other
// failure (bad request, network blip) isn't retried against a different
// provider, since that's unlikely to help and just adds latency.
function isRateLimitError(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('rate limit') || s.includes('429') || s.includes('tokens per day')
    || s.includes('tokens per minute') || s.includes(' tpd') || s.includes(' tpm')
    || s.includes('quota');
}

async function chatGroqOnly(messages, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { success: false, error: 'AI engine unavailable' };

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: opts.temperature ?? 0,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.choices?.[0]) {
      const errMsg = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
      console.warn(`[Groq] request failed (${res.status}): ${errMsg}`);
      return { success: false, error: errMsg };
    }
    return { success: true, data, modelUsed: GROQ_MODEL };
  } catch (e) {
    // Network down, DNS failure, etc.
    console.warn('[Groq] request threw:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Send a chat completion to Groq, falling back to OpenRouter's free tier if
 * Groq is rate-limited and a fallback key is configured.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ json?: boolean, maxTokens?: number, temperature?: number }} opts
 * @returns {Promise<{success:boolean, data?:object, error?:string, modelUsed?:string}>}
 *          `data` is the raw OpenAI-compatible response body.
 */
async function chat(messages, opts = {}) {
  const primary = await chatGroqOnly(messages, opts);
  if (primary.success) return primary;

  if (isRateLimitError(primary.error) && openrouter.isConfigured()) {
    console.log(`[Groq] rate-limited, falling back to OpenRouter (${openrouter.getModel()})`);
    const fallback = await openrouter.chat(messages, opts);
    if (fallback.success) return fallback;
    return { success: false, error: `${primary.error} (OpenRouter fallback also failed: ${fallback.error})` };
  }

  return primary;
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

module.exports = { GROQ_MODEL, loadDotEnv, isConfigured, chat, chatJson, isRateLimitError };
