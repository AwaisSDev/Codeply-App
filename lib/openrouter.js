/**
 * Codeply — OpenRouter fallback AI engine
 *
 * Used ONLY as a fallback when Groq is genuinely rate-limited (daily or
 * per-minute quota hit) — Groq stays the primary provider everywhere. Key
 * comes from the OPENROUTER_API_KEY environment variable ONLY (never
 * persisted, never shown in the UI). If it's absent, the fallback is simply
 * unavailable and callers just see the original Groq error, same as before
 * this existed.
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// OpenRouter's free-tier models get swapped/retired over time (this app has
// hit that exact problem before with a different provider's free model) —
// override via OPENROUTER_MODEL if this one stops working, no code change needed.
const DEFAULT_MODEL = 'poolside/laguna-xs-2.1:free';

let warnedMissingKey = false;

function getApiKey() {
  return (process.env.OPENROUTER_API_KEY || '').trim() || null;
}

function getModel() {
  return (process.env.OPENROUTER_MODEL || '').trim() || DEFAULT_MODEL;
}

function isConfigured() {
  return !!getApiKey();
}

/**
 * Send a chat completion to OpenRouter. Same shape as lib/groq.js's chat().
 * @returns {Promise<{success:boolean, data?:object, error?:string, modelUsed?:string}>}
 */
async function chat(messages, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        '[OpenRouter] OPENROUTER_API_KEY not set — no fallback available when ' +
        'Groq is rate-limited. Set it to enable one (free tier works fine).'
      );
    }
    return { success: false, error: 'OpenRouter fallback unavailable' };
  }

  const model = getModel();
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://codeply.app',
        'X-Title': 'Codeply',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.choices?.[0]) {
      const errMsg = data?.error?.message || data?.error?.code || `HTTP ${res.status}`;
      console.warn(`[OpenRouter] request failed (${res.status}): ${errMsg}`);
      return { success: false, error: errMsg };
    }
    return { success: true, data, modelUsed: model };
  } catch (e) {
    console.warn('[OpenRouter] request threw:', e.message);
    return { success: false, error: e.message };
  }
}

module.exports = { DEFAULT_MODEL, getModel, isConfigured, chat };
