const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
  safeStorage
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ─── Supabase Config ───────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://zswkhfkfseclgadhvobg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpzd2toZmtmc2VjbGdhZGh2b2JnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMzYyOTgsImV4cCI6MjA5NTgxMjI5OH0.EoTQdIGQQDrN1uEqQfya3VmrQMT68jkzPLphbLwNTWg';

// Encryption/decryption handled server-side by the 'api-key' Edge Function.
// API_KEY_MASTER_SECRET lives only in Supabase secrets — never in this binary.

let supabase = null;
let pendingAuthUrl = null;
let supabaseReadyPromise = null;

// File-based storage adapter for Supabase session persistence (Node.js context)
function getSupabaseStoragePath() {
  return path.join(app.getPath('userData'), 'codeply-auth.json');
}
const supabaseStorage = {
  getItem(key) {
    try { const d = JSON.parse(fs.readFileSync(getSupabaseStoragePath(), 'utf8')); return d[key] || null; }
    catch { return null; }
  },
  setItem(key, value) {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(getSupabaseStoragePath(), 'utf8')); } catch { }
    d[key] = value;
    try { fs.writeFileSync(getSupabaseStoragePath(), JSON.stringify(d)); } catch { }
  },
  removeItem(key) {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(getSupabaseStoragePath(), 'utf8')); } catch { }
    delete d[key];
    try { fs.writeFileSync(getSupabaseStoragePath(), JSON.stringify(d)); } catch { }
  }
};

function getDeepLinkFromArgv(argv = process.argv) {
  return argv.find(arg => typeof arg === 'string' && arg.startsWith('codeply://')) || null;
}

function ensureSupabaseReady() {
  if (!supabaseReadyPromise) {
    supabaseReadyPromise = initSupabase();
  }
  return supabaseReadyPromise;
}

async function initSupabase() {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const ws = require('ws');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: supabaseStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'pkce'
      },
      realtime: { transport: ws }
    });
    console.log('[Supabase] Initialized');
  } catch (e) {
    console.error('[Supabase] Init error:', e.message);
  }
}

function sessionUserFromAuth(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || '',
    name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User',
    avatar: user.user_metadata?.avatar_url || ''
  };
}

async function persistAuthUser(user) {
  const mapped = sessionUserFromAuth(user);
  if (!mapped) return null;
  savedSettings.user = { name: mapped.name, email: mapped.email, avatar: mapped.avatar };
  persistSettings();
  // Load this user's API key + settings from the cloud
  await fetchCloudSettings(user.id);
  return mapped;
}

// ── Cloud settings (Supabase user_settings table) ─────────────────────────────

/** Returns a valid access token: uses the current session if fresh, refreshes if expired. */
async function getValidAccessToken() {
  if (!supabase) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    // If token expires in more than 60 seconds, use it as-is
    const expiresAt = session.expires_at ?? 0;
    if (Math.floor(Date.now() / 1000) < expiresAt - 60) return session.access_token;
    // Token expired or about to — refresh it
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (error || !refreshed?.session) return null;
    return refreshed.session.access_token;
  } catch { return null; }
}

// ── Direct Supabase helpers (history — non-sensitive, no encryption needed) ────

/** Log a single AI call to usage_history. Fire-and-forget. */
async function logUsageToCloud({ model, tokensIn, tokensOut, tokensTotal, promptText, filePath }) {
  if (!supabase) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    await supabase.from('usage_history').insert({
      user_id:     session.user.id,
      model:       model || '',
      tokens_in:   tokensIn   || 0,
      tokens_out:  tokensOut  || 0,
      tokens_total: tokensTotal || 0,
      prompt_text: (promptText || '').slice(0, 300),
      file_path:   filePath || '',
    });
  } catch (e) { console.warn('[Cloud] history log failed:', e.message); }
}

// ── Cloud settings ─────────────────────────────────────────────────────────────

async function fetchCloudSettings(userId) {
  if (!supabase || !userId) return;
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) { savedSettings.apiKey = ''; persistSettings(); return; }

    const res = await fetch(`${SUPABASE_URL}/functions/v1/api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action: 'get' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      savedSettings.apiKey = ''; savedSettings.model = ''; savedSettings.tokenCap = 0;
      persistSettings(); return;
    }

    // Always overwrite with cloud values — never fall back to leftover local
    // settings from a previous account (that's what leaks keys across accounts).
    savedSettings.apiKey   = data.api_key || '';
    savedSettings.provider = data.provider || 'openrouter';
    savedSettings.model    = data.model    || '';
    savedSettings.tokenCap = (data.token_cap !== undefined && data.token_cap !== null) ? data.token_cap : 0;
    // Only overwrite modelRanking if cloud explicitly returned it.
    // If the field is absent (edge function not redeployed yet), keep local copy.
    if (data.model_ranking !== undefined && data.model_ranking !== null) {
      savedSettings.modelRanking = Array.isArray(data.model_ranking) ? data.model_ranking : [];
    }

    persistSettings();
    console.log('[Cloud] Settings loaded for user', userId, '— models:', savedSettings.modelRanking.length);
  } catch (e) {
    console.warn('[Cloud] fetchCloudSettings error:', e.message);
    savedSettings.apiKey = ''; savedSettings.model = ''; savedSettings.tokenCap = 0;
    persistSettings();
  }
}

async function pushCloudSettings(userId, data) {
  if (!supabase || !userId) return { success: false, error: 'Not logged in' };
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return { success: false, error: 'Session expired — please log in again' };

    const res = await fetch(`${SUPABASE_URL}/functions/v1/api-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        action:        'save',
        api_key:       data.apiKey       ?? savedSettings.apiKey       ?? '',
        provider:      data.provider     ?? savedSettings.provider     ?? 'openrouter',
        model:         data.model        ?? savedSettings.model        ?? '',
        token_cap:     data.tokenCap     ?? savedSettings.tokenCap     ?? 0,
        model_ranking: data.modelRanking ?? savedSettings.modelRanking ?? [],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.error || `HTTP ${res.status}`;
      console.warn('[Cloud] pushCloudSettings error:', detail);
      return { success: false, error: detail };
    }
    console.log('[Cloud] Settings saved (server-encrypted) for user', userId);
    return { success: true };
  } catch (e) {
    console.warn('[Cloud] pushCloudSettings error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── AI call engine ────────────────────────────────────────────────────────────

/** Base URL for each provider. */
function providerUrl(provider, customUrl) {
  switch (provider) {
    case 'openai':    return 'https://api.openai.com/v1/chat/completions';
    case 'groq':      return 'https://api.groq.com/openai/v1/chat/completions';
    case 'xai':
    case 'grok':      return 'https://api.x.ai/v1/chat/completions';
    case 'deepseek':  return 'https://api.deepseek.com/v1/chat/completions';
    case 'kimi':      return 'https://api.moonshot.cn/v1/chat/completions';
    case 'google':    return 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    case 'custom':    return customUrl || 'https://openrouter.ai/api/v1/chat/completions';
    default:          return 'https://openrouter.ai/api/v1/chat/completions';
  }
}

/** Call one model entry. Returns { ok, status, data }. */
async function callSingleModel(entry, messages, expectJson) {
  const url = providerUrl(entry.provider, entry.customUrl);

  // Anthropic has a different request/response format
  if (entry.provider === 'anthropic') {
    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': entry.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: entry.modelId,
        max_tokens: 8192,
        ...(sysMsg ? { system: sysMsg } : {}),
        messages: chatMsgs,
      }),
    });
    const data = await res.json();
    // Normalize to OpenAI-style response
    if (data.content?.[0]?.text) {
      data.choices = [{ message: { content: data.content[0].text, role: 'assistant' } }];
      data.usage = { total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) };
    }
    return { ok: res.ok, status: res.status, data };
  }

  // OpenAI-compatible (OpenRouter, OpenAI, Groq, xAI, DeepSeek, Kimi, Google)
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${entry.apiKey}`,
  };
  if ((entry.provider || 'openrouter') === 'openrouter') {
    headers['HTTP-Referer'] = 'https://codeply.app';
    headers['X-Title'] = 'Codeply';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: entry.modelId,
      messages,
      temperature: 0,
      ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/**
 * Call AI using a specific selected model (by id), with fallback through
 * remaining enabled models, then the poolside default.
 * selectedModelId: the model.id the user picked in the popup (may be null).
 */
async function callAI(selectedModelId, messages, expectJson = true) {
  const allModels = (savedSettings.modelRanking || [])
    .filter(m => m.enabled !== false && m.apiKey && m.modelId);

  // Put selected model first, then the rest in order
  let ordered;
  if (selectedModelId) {
    const sel = allModels.find(m => m.id === selectedModelId);
    const rest = allModels.filter(m => m.id !== selectedModelId);
    ordered = sel ? [sel, ...rest] : allModels;
  } else {
    ordered = allModels;
  }

  const tried = [];
  for (const model of ordered) {
    try {
      console.log(`[AI] Trying ${model.modelId}`);
      const { ok, status, data } = await callSingleModel(model, messages, expectJson);
      if (ok && data.choices?.[0]) {
        console.log(`[AI] ✓ ${model.modelId}`);
        // Notify the popup if we fell back from a failing model
        if (tried.length > 0 && popupWindow && !popupWindow.isDestroyed()) {
          popupWindow.webContents.send('ai:model-fallback', { failed: tried, used: model.modelId });
        }
        return { success: true, data, modelUsed: model.modelId };
      }
      const errMsg = data?.error?.message || data?.error?.code || `HTTP ${status}`;
      tried.push(`${model.modelId}: ${errMsg}`);
      console.warn(`[AI] ${model.modelId} failed (${status}): ${errMsg}`);
    } catch (e) {
      tried.push(`${model.modelId}: ${e.message}`);
      console.warn(`[AI] ${model.modelId} threw: ${e.message}`);
    }
  }

  // Legacy single-model fallback (backward compat with old single-key settings)
  if (savedSettings.apiKey && savedSettings.model) {
    try {
      const legacy = { provider: savedSettings.provider || 'openrouter', modelId: savedSettings.model, apiKey: savedSettings.apiKey };
      const { ok, data } = await callSingleModel(legacy, messages, expectJson);
      if (ok && data.choices?.[0]) {
        console.log('[AI] ✓ Legacy model');
        return { success: true, data, modelUsed: savedSettings.model };
      }
    } catch { /* ignore */ }
  }

  const errDetail = tried.length > 0
    ? `All models failed. Last: ${tried.slice(-2).join(' | ')}`
    : 'No models configured. Add a model in Settings.';
  return { success: false, error: errDetail };
}

/** Get the Supabase user ID of the currently logged-in user, or null. */
async function getLoggedInUserId() {
  if (!supabase) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id || null;
  } catch { return null; }
}

async function ensureDashboardReady() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    createDashboardWindow();
  }
  const win = dashboardWindow;
  if (win.webContents.isLoadingMainFrame()) {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  }
  return win;
}

function sendAuthCallback(payload) {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  dashboardWindow.show();
  dashboardWindow.focus();
  // Give renderer 300ms to wire up onCallback listener
  setTimeout(() => {
    dashboardWindow.webContents.send('auth:callback', payload);
  }, 300);
}

// Called when OS hands us back the codeply:// deep link after OAuth
async function handleAuthCallback(url) {
  if (!url) return;
  if (!supabase) {
    pendingAuthUrl = url;
    await ensureSupabaseReady();
    if (!supabase) return;
  }

  console.log('[Auth] Callback received:', url.slice(0, 80));
  try {
    const win = await ensureDashboardReady();
    const parsedUrl = new URL(url);
    const code = parsedUrl.searchParams.get('code');
    if (!code) {
      sendAuthCallback({ success: false, error: 'No auth code in callback URL.' });
      return;
    }
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      sendAuthCallback({ success: false, error: error.message });
      return;
    }
    const mapped = await persistAuthUser(data.session?.user);
    if (!mapped) {
      sendAuthCallback({ success: false, error: 'Session exchange succeeded but no user was returned.' });
      return;
    }
    sendAuthCallback({ success: true, user: mapped });
  } catch (e) {
    console.error('[Auth] Callback error:', e.message);
    sendAuthCallback({ success: false, error: e.message });
  }
}

async function flushPendingAuthCallback() {
  if (!pendingAuthUrl) return;
  const url = pendingAuthUrl;
  pendingAuthUrl = null;
  await handleAuthCallback(url);
}

// Disable GPU hardware acceleration — prevents blank/white screen on some Windows configs
app.disableHardwareAcceleration();

// Single-instance lock + deep-link protocol registration (must be before app ready)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// Register codeply:// protocol for OAuth deep links
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('codeply', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('codeply');
}

// Windows / Linux: second instance carries the deep-link URL as a CLI arg
app.on('second-instance', async (event, commandLine) => {
  const url = getDeepLinkFromArgv(commandLine);
  if (url) {
    await ensureSupabaseReady();
    handleAuthCallback(url);
  }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.show(); dashboardWindow.focus(); }
});

// macOS: deep link fires on the running instance via open-url
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('codeply://')) handleAuthCallback(url);
});

let popupWindow;
let dashboardWindow;
let tray;

const configPath = path.join(app.getPath('userData'), 'codeply-config.json');
const usagePath = path.join(app.getPath('userData'), 'codeply-usage.json');

// ─── Config & Usage Persistence ───────────────────────────────────────────────

// ── API-key encryption using Electron safeStorage (OS keychain/DPAPI) ──────────
// On disk: { apiKey: '<base64 ciphertext>', apiKeyEncrypted: true }
// In memory (savedSettings): apiKey is always plaintext for API calls
function encryptApiKey(plaintext) {
  if (!plaintext) return { value: '', encrypted: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plaintext);
      return { value: buf.toString('base64'), encrypted: true };
    }
  } catch (e) { console.warn('[safeStorage] encrypt failed:', e.message); }
  return { value: plaintext, encrypted: false };
}

function decryptApiKey(stored, wasEncrypted) {
  if (!stored || !wasEncrypted) return stored;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    }
  } catch (e) { console.warn('[safeStorage] decrypt failed:', e.message); }
  return stored;
}

function loadSettings() {
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Decrypt the API key so the rest of the app always sees plaintext
      if (raw.apiKeyEncrypted && raw.apiKey) {
        raw.apiKey = decryptApiKey(raw.apiKey, true);
        delete raw.apiKeyEncrypted;
      }
      return raw;
    }
  } catch (e) { console.error("Config load error:", e); }
  return { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: '', theme: 'dark', hotkey: 'Alt+C', user: null, popupPos: null, watchFolder: '', modelRanking: [] };
}

function loadUsage() {
  try {
    if (fs.existsSync(usagePath)) return JSON.parse(fs.readFileSync(usagePath, 'utf8'));
  } catch (e) { console.error("Usage load error:", e); }
  return { totalTokens: 0, totalRequests: 0, sessions: [], history: [] };
}

function saveUsage(usage) {
  try { fs.writeFileSync(usagePath, JSON.stringify(usage, null, 2)); } catch (e) { console.error("Usage save error:", e); }
}

function persistSettings() {
  try {
    // Encrypt the API key before writing — savedSettings keeps plaintext in memory
    const toWrite = { ...savedSettings };
    if (toWrite.apiKey) {
      const { value, encrypted } = encryptApiKey(toWrite.apiKey);
      toWrite.apiKey = value;
      if (encrypted) toWrite.apiKeyEncrypted = true;
    }
    fs.writeFileSync(configPath, JSON.stringify(toWrite, null, 2));
  } catch (e) { console.error("Settings save error:", e); }
}

let savedSettings = loadSettings();
let usageData = loadUsage();

// Active-file watcher state
let activeFilePath = null;       // currently auto-detected target file
let watchTimer = null;           // folder-poll interval
let clipboardTimer = null;       // clipboard auto-refresh interval
let lastClipboard = '';          // de-dupe clipboard polling

// ─── Popup Window ──────────────────────────────────────────────────────────────

function defaultPopupPos() {
  const POPUP_W = 380, POPUP_H = 540;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return { x: width - POPUP_W - 24, y: height - POPUP_H - 24 };
}

function createPopupWindow() {
  const POPUP_W = 380, POPUP_H = 540;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  // Default = bottom-right with a 24px gutter; restore last dragged spot if saved.
  const def = defaultPopupPos();
  let x = def.x, y = def.y;
  const saved = savedSettings.popupPos;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    x = saved.x;
    y = saved.y;
  }
  // Clamp on-screen so it never spawns off in the void.
  x = Math.min(Math.max(0, x), Math.max(0, width - POPUP_W));
  y = Math.min(Math.max(0, y), Math.max(0, height - POPUP_H));

  popupWindow = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    minimizable: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remember wherever the user drags it (debounced).
  let moveSaveTimer = null;
  popupWindow.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const [px, py] = popupWindow.getPosition();
      savedSettings.popupPos = { x: px, y: py };
      persistSettings();
    }, 400);
  });

  popupWindow.loadFile(path.join(__dirname, 'Renderer', 'index.html'));
  popupWindow.hide();
}

// ─── Dashboard Window ──────────────────────────────────────────────────────────

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 760,
    frame: false,
    transparent: false,
    show: false,            // start hidden — Codeply lives in the tray
    backgroundColor: '#f1f3f4',
    icon: path.join(__dirname, 'assets', 'Favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'Dashboard', 'index.html'));
  // Close button hides instead of quitting, so it keeps running in the background.
  dashboardWindow.on('close', (e) => {
    if (!app.isQuiting) { e.preventDefault(); dashboardWindow.hide(); }
  });
}

// ─── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'Favicon.ico');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); } else { createDashboardWindow(); } } },
    { label: 'Toggle Overlay', click: togglePopup },
    { label: 'Reset Popup Position', click: resetPopupPosition },
    { type: 'separator' },
    { label: 'Quit Codeply', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setToolTip('Codeply AI');
  tray.setContextMenu(contextMenu);
  tray.on('click', togglePopup);
}

function resetPopupPosition() {
  if (!popupWindow) return;
  savedSettings.popupPos = null;
  persistSettings();
  const def = defaultPopupPos();
  popupWindow.setPosition(def.x, def.y);
  if (!popupWindow.isVisible()) { popupWindow.show(); popupWindow.focus(); }
}

function togglePopup() {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
  } else {
    // Re-assert position every show: last dragged spot, else bottom-right default.
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const def = defaultPopupPos();
    const saved = savedSettings.popupPos;
    let x = (saved && Number.isFinite(saved.x)) ? saved.x : def.x;
    let y = (saved && Number.isFinite(saved.y)) ? saved.y : def.y;
    x = Math.min(Math.max(0, x), Math.max(0, width - 380));
    y = Math.min(Math.max(0, y), Math.max(0, height - 500));
    popupWindow.setPosition(Math.round(x), Math.round(y));

    pushClipboardSnippet(true);   // force a sync of whatever's on the clipboard
    sendActiveFile();             // surface the currently-detected target file
    popupWindow.show();
    popupWindow.focus();
  }
}

// ─── Language Detection ────────────────────────────────────────────────────────

function detectLanguage(code) {
  if (!code) return 'Code';
  if (code.includes('def ') || code.includes('import ') && code.includes(':')) return 'Python';
  if (code.includes('function ') || code.includes('=>') || code.includes('const ') || code.includes('let ')) return 'JavaScript';
  if (code.includes('interface ') || code.includes(': string') || code.includes(': number')) return 'TypeScript';
  if (code.includes('<div') || code.includes('</') || code.includes('className=')) return 'JSX/HTML';
  if (code.includes('SELECT ') || code.includes('FROM ') || code.includes('WHERE ')) return 'SQL';
  if (code.includes('pub fn') || code.includes('let mut')) return 'Rust';
  if (code.includes('func ') && code.includes('{')) return 'Go';
  return 'Code';
}

// ─── Code Heuristic ────────────────────────────────────────────────────────────
// "Detect code only" — ignore plain prose copied to the clipboard so the popup
// only reacts to actual code snippets.
function looksLikeCode(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;

  // Strong signals: code punctuation / structure
  const signals = [
    /[{}();]/, /=>/, /==|!=|<=|>=|\+=|-=/, /\b(function|const|let|var|class|def|import|export|return|if|else|for|while|public|private|void|int|async|await)\b/,
    /<\/?[a-z][\s\S]*>/i, /^\s*[#@].+/m, /\bclassName=|\bstyle=/, /::|->|\$\(/
  ];
  let score = 0;
  for (const re of signals) if (re.test(t)) score++;

  // Multi-line + indentation is a good code tell
  const lines = t.split('\n');
  if (lines.length > 1) score++;
  if (lines.some(l => /^\s{2,}\S/.test(l) || /^\t/.test(l))) score++;

  // Penalise prose: long runs of words with sentence punctuation and no symbols
  const proseRatio = (t.match(/[a-zA-Z ,.]/g) || []).length / t.length;
  if (proseRatio > 0.95 && score < 2) return false;

  return score >= 2;
}

// ─── Instruction Detection ──────────────────────────────────────────────────────
// Natural-language edit commands like "remove all headings", "add a nav bar",
// "Remove this text". These aren't code — they tell Codeply what to DO to the file.
const INSTRUCTION_RE = /^\s*(please\s+)?(remove|delete|erase|drop|strip|add|insert|create|append|change|replace|swap|rename|update|fix|refactor|move|wrap|make|turn|convert|comment|uncomment|set|put)\b/i;
function looksLikeInstruction(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 500) return false;                       // long → probably real code/doc
  const lines = t.split('\n');
  if (lines.length > 5) return false;                     // multi-line → probably code
  const first = lines[0];
  if (/[{};]\s*$/.test(first)) return false;              // ends like a code statement
  return INSTRUCTION_RE.test(first);
}

// ─── Snippet Cleaner ────────────────────────────────────────────────────────────
// Strip markdown fences and surrounding AI prose/explanations so ONLY real code
// gets written into the file — never the chatbot's documentation.
function cleanSnippet(text) {
  if (!text) return '';
  let t = text.replace(/\r\n/g, '\n');

  // 1) Real fenced ```blocks```: take the LARGEST one (the most complete version).
  //    A chat answer often shows a small fragment AND the full updated file — the
  //    big block is the safe pick. Gluing them together is what produced the
  //    duplicated / nested junk you saw, so we deliberately don't concatenate.
  const fences = [...t.matchAll(/```[a-zA-Z0-9+#.\-]*[ \t]*\n?([\s\S]*?)```/g)]
    .map(f => f[1].replace(/^\n+|\n+$/g, ''));
  if (fences.length) {
    t = fences.reduce((big, cur) => (cur.length > big.length ? cur : big), '');
  } else {
    t = t.replace(/^[ \t]*```.*$/gm, '');   // strip stray / mangled fence markers
  }

  // 2) Strip the junk left behind when a chat answer is pasted as plain text:
  //      - bare language labels on their own line ("HTML", "javascript", …)
  //      - interleaved prose / instructions that aren't code or markup
  //    (We strip these ANYWHERE now, not just at the top and bottom.)
  const LANG = /^(html|xml|js|javascript|jsx|ts|typescript|tsx|css|scss|sass|json|py|python|bash|sh|shell|go|golang|rust|rs|java|kotlin|c|cpp|c\+\+|cs|csharp|php|ruby|rb|sql|yaml|yml|vue|svelte|markdown|md)$/i;

  const isProse = (s) => {
    if (!s) return false;
    if (/^(\/\/|#|\*|\/\*|--|<!--)/.test(s)) return false;   // a real code comment -> keep
    // A full sentence that doesn't open or close like code -> prose (even if it
    // happens to mention a <tag>, e.g. "You can target the existing <main> block.")
    if (/[.!?]$/.test(s) && s.split(/\s+/).length >= 5 && !/^[<{[(]/.test(s) && !/[)};]$/.test(s)) return true;
    if (/[{}<>();=\[\]]/.test(s)) return false;              // otherwise code/markup -> keep
    if (/[,;:]\s*$/.test(s)) return false;
    if (s.split(/\s+/).length < 2) return false;
    return /^(here|here'?s|this|that|the|these|those|note|now|first|next|then|finally|you|i|we|to|add|use|replace|change|update|make|so|it|its|simply|just|below|above|where|new|step|example)\b/i.test(s);
  };

  const lines = t.split('\n').filter(line => {
    const s = line.trim();
    if (LANG.test(s)) return false;
    if (isProse(s)) return false;
    return true;
  });

  return lines.join('\n').replace(/^\n+|\n+$/g, '').trim();
}

// ─── Full-File Replace Detection ────────────────────────────────────────────────
// A full-file overwrite is dangerous, so we only trigger it when the user is
// unambiguous: either the clipboard is a complete HTML document, or the
// instruction explicitly says "whole/entire/full file". Everything else falls
// through to surgical snippet placement so we never wipe a file by accident.
const REPLACE_LEAD_RE = /^\s*(?:please\s+)?(?:(?:replace|swap|overwrite|update|change|use)\b[^\n]*?\b(?:with|to|using|by|following|instead)\b[^\n]*|(?:here(?:'s| is)|this is)\s+the\s+(?:new|updated|full|complete)\b[^\n]*|new\s+(?:code|version|file|html)\b[^\n]*?:?)\s*\n([\s\S]+)$/i;
const WHOLE_FILE_RE = /\b(whole|entire|full|complete)\s+(file|document|code|page|component|script|thing)\b|\b(everything|all\s+(the\s+)?(code|content))\b|\brewrite\s+the\s+file\b/i;

function isFullDocument(body) {
  return /^\uFEFF?\s*<!doctype html/i.test(body) || /^\uFEFF?\s*<html[\s>]/i.test(body);
}

function parseReplaceCommand(text) {
  if (!text) return null;
  const t = text.replace(/\r\n/g, '\n');

  // (a) Clipboard is itself a complete HTML document -> genuine full-file replace.
  const whole = cleanSnippet(t) || t.trim();
  if (isFullDocument(whole)) {
    return { content: whole, reason: 'Complete HTML document detected — overwriting the whole file.' };
  }

  // (b) Explicit "replace the WHOLE/ENTIRE file with ..." with code on the lines below.
  const m = t.match(REPLACE_LEAD_RE);
  const firstLine = t.split('\n')[0] || '';
  if (m && m[1] && WHOLE_FILE_RE.test(firstLine)) {
    const body = cleanSnippet(m[1]) || m[1].trim();
    if (body.length > 20) {
      return { content: body, reason: 'Explicit whole-file replace — overwriting the file with the pasted code.' };
    }
  }

  // Otherwise NOT a full-file overwrite. Let snippet placement handle it so we
  // only edit the relevant block instead of wiping the file.
  return null;
}

// ─── Clipboard Auto-Refresh (code only) ────────────────────────────────────────
function pushClipboardSnippet(force = false) {
  const text = clipboard.readText();
  if (!popupWindow || popupWindow.isDestroyed()) return;

  const replaceAll = !!parseReplaceCommand(text);
  const instruction = !replaceAll && looksLikeInstruction(text);
  const code = !replaceAll && !instruction && looksLikeCode(text);
  const actionable = replaceAll || instruction || code;

  // Only react to genuine code/commands; skip duplicates unless forced.
  if (!force) {
    if (text === lastClipboard) return;
    if (!actionable) return;
  }
  lastClipboard = text;

  let summary, kind, language;
  if (!text) { summary = 'Copy code or type an instruction to get started.'; kind = 'none'; language = '–'; }
  else if (replaceAll) { summary = 'Full replace detected — Analyze to overwrite the target file.'; kind = 'replace'; language = 'Replace'; }
  else if (instruction) { summary = 'Instruction detected. Target a file, then hit Analyze.'; kind = 'instruction'; language = 'Command'; }
  else if (code) { summary = 'Code detected. Hit Analyze to find its placement.'; kind = 'code'; language = detectLanguage(text); }
  else { summary = 'Copied text isn’t code or an instruction.'; kind = 'none'; language = '–'; }

  popupWindow.webContents.send('snippet:update', {
    text: text || '',
    preview: text || '',
    language,
    lineCount: text ? text.split('\n').length : 0,
    summary,
    isCode: actionable,                       // controls whether Analyze is enabled
    kind
  });
}

function startClipboardWatch() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  // Auto-refresh every 10 seconds, code only.
  clipboardTimer = setInterval(() => pushClipboardSnippet(false), 10000);
}

// ─── Active-File Detection ─────────────────────────────────────────────────────
// Watches the chosen project folder and targets the most-recently-modified code
// file — i.e. the file you're actively editing/saving — so Analyze + Apply always
// have a real destination instead of falling back to preview-only.
const CODE_EXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.html', '.css', '.json', '.vue', '.svelte']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'vendor']);

function findMostRecentFile(dir, depth = 0, best = { path: null, mtime: 0 }) {
  if (depth > 6) return best;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return best; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.isDirectory()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue;
      findMostRecentFile(full, depth + 1, best);
    } else if (CODE_EXT.has(path.extname(ent.name).toLowerCase())) {
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > best.mtime) { best.mtime = m; best.path = full; }
      } catch (e) { /* skip */ }
    }
  }
  return best;
}

function pollActiveFile() {
  const folder = savedSettings.watchFolder;
  if (!folder || !fs.existsSync(folder)) return;
  const best = findMostRecentFile(folder);
  if (best.path && best.path !== activeFilePath) {
    activeFilePath = best.path;
    sendActiveFile();
  }
}

function sendActiveFile() {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  let lineCount = 0;
  try { lineCount = fs.readFileSync(activeFilePath, 'utf8').split('\n').length; } catch (e) { /* skip */ }
  popupWindow.webContents.send('active-file:update', {
    path: activeFilePath,
    name: activeFilePath ? path.basename(activeFilePath) : null,
    lineCount
  });
}

function startFolderWatch() {
  if (watchTimer) clearInterval(watchTimer);
  activeFilePath = null;
  pollActiveFile();
  // Re-scan every 3s so saving a file in your editor re-targets it quickly.
  watchTimer = setInterval(pollActiveFile, 3000);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.on('refresh-clipboard', () => {
  pushClipboardSnippet(true);
  sendActiveFile();
});

ipcMain.handle('settings:get', () => savedSettings);

ipcMain.handle('settings:save', async (_, settings) => {
  const prevFolder = savedSettings.watchFolder;
  const prevHotkey = savedSettings.hotkey;
  savedSettings = { ...savedSettings, ...settings };
  persistSettings();
  if (settings.watchFolder !== undefined && settings.watchFolder !== prevFolder) {
    startFolderWatch();
  }
  // Re-register the global hotkey live so it applies without a restart.
  if (settings.hotkey !== undefined && settings.hotkey !== prevHotkey) {
    try {
      globalShortcut.unregisterAll();
      globalShortcut.register(savedSettings.hotkey || 'Alt+C', togglePopup);
    } catch (e) { console.warn('[hotkey] live re-register failed:', e.message); }
  }
  // Push API key + AI settings to the cloud if user is logged in
  const userId = await getLoggedInUserId();
  if (userId) {
    const cloudResult = await pushCloudSettings(userId, settings);
    if (!cloudResult.success) {
      return { success: false, error: cloudResult.error };
    }
  }
  // Tell the popup + dashboard to pull the new API key / model list immediately,
  // so the next AI request uses them — no app restart needed.
  broadcastSettingsUpdated();
  return { success: true };
});

// Notify all open windows that settings changed so they can hot-reload.
function broadcastSettingsUpdated() {
  [popupWindow, dashboardWindow].forEach(w => {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('settings:updated', savedSettings); } catch {}
    }
  });
}

// ─── Watch-folder controls ──────────────────────────────────────────────────────
ipcMain.handle('watch:get', () => ({
  folder: savedSettings.watchFolder || '',
  activeFile: activeFilePath
}));

ipcMain.handle('watch:pick-folder', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(popupWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  savedSettings.watchFolder = result.filePaths[0];
  persistSettings();
  startFolderWatch();
  return savedSettings.watchFolder;
});

ipcMain.handle('usage:get', () => usageData);

ipcMain.handle('usage:reset', () => {
  usageData = { totalTokens: 0, totalRequests: 0, sessions: [], history: [] };
  saveUsage(usageData);
  return { success: true };
});

ipcMain.handle('history:get-cloud', async () => {
  if (!supabase) return [];
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return [];
    const { data, error } = await supabase
      .from('usage_history')
      .select('id, created_at, model, tokens_in, tokens_out, tokens_total, prompt_text, file_path')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(200);
    return error ? [] : (data || []);
  } catch { return []; }
});

ipcMain.handle('history:get-cloud-stats', async () => {
  if (!supabase) return { totalTokens: 0, totalRequests: 0, byModel: {} };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { totalTokens: 0, totalRequests: 0, byModel: {} };
    const { data, error } = await supabase
      .from('usage_history')
      .select('model, tokens_in, tokens_out, tokens_total')
      .eq('user_id', session.user.id);
    if (error || !data) return { totalTokens: 0, totalRequests: 0, byModel: {} };
    const totalTokens = data.reduce((s, r) => s + (r.tokens_total || 0), 0);
    const byModel = {};
    data.forEach(r => {
      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = { tokens: 0, requests: 0 };
      byModel[m].tokens   += r.tokens_total || 0;
      byModel[m].requests += 1;
    });
    return { totalTokens, totalRequests: data.length, byModel };
  } catch { return { totalTokens: 0, totalRequests: 0, byModel: {} }; }
});

ipcMain.handle('popup:dismiss', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
});
ipcMain.handle('popup:minimize', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.minimize();
});
ipcMain.handle('popup:close', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
});
ipcMain.handle('dashboard:open', () => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.show(); dashboardWindow.focus(); }
  else createDashboardWindow();
});
ipcMain.handle('dashboard:minimize', () => { if (dashboardWindow) dashboardWindow.minimize(); });
ipcMain.handle('dashboard:maximize', () => {
  if (dashboardWindow) { dashboardWindow.isMaximized() ? dashboardWindow.unmaximize() : dashboardWindow.maximize(); }
});
ipcMain.handle('dashboard:close', () => { if (dashboardWindow) dashboardWindow.hide(); });
ipcMain.handle('app:quit', () => { app.isQuiting = true; app.quit(); });
ipcMain.handle('app:restart', () => { app.relaunch(); app.exit(0); });

// ── Auto-updater controls (driven by the in-app update page) ──────────────────
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:download', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:install', () => {
  // Mark as quitting so the dashboard's close handler doesn't swallow the quit,
  // then quit → run the installer silently → relaunch the new version.
  app.isQuiting = true;
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(true, true); }
    catch (e) { console.warn('[updater] quitAndInstall failed:', e.message); }
  });
  return { ok: true };
});
ipcMain.handle('shell:open-external', async (_, url) => {
  console.log('[codeply] open-external called:', url);
  try {
    await shell.openExternal(url);
    console.log('[codeply] shell.openExternal succeeded');
  } catch (e) {
    console.error('[codeply] shell.openExternal failed:', e.message);
    exec(`cmd.exe /c start "" "${url}"`, (err) => {
      if (err) console.error('[codeply] exec fallback failed:', err.message);
      else console.log('[codeply] exec fallback succeeded');
    });
  }
});

// ─── Local Heuristic Placement (no API key needed) ──────────────────────────────
// A pragmatic offline fallback: find where the snippet *belongs* by matching a
// declared identifier (function/const/class/def/id) against the target file.
function localAnalyze(code, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { action: 'append', startLine: null, endLine: null, anchor: null, reason: 'No target file — paste preview only.', confidence: 40, code };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const first = (code.trim().split('\n')[0] || '').trim();

  // 0) HTML element block? If the snippet is a full <tag>…</tag> element, try to
  //    replace the SAME element already in the file (matched by id if present,
  //    else by the first occurrence of that tag). This is what makes "paste the
  //    updated <main> block" work offline instead of appending a duplicate.
  const tagOpen = first.match(/^<([a-zA-Z][\w-]*)\b/);
  if (tagOpen) {
    const tag = tagOpen[1];
    const snippetId = (first.match(/\bid=["']([\w-]+)["']/) || [])[1] || null;
    const hasClose = new RegExp(`</${tag}>`).test(code);
    const openRe = new RegExp(`<${tag}\\b`);
    for (let i = 0; i < lines.length; i++) {
      if (!openRe.test(lines[i])) continue;
      // If the snippet declares an id, only match the element with that same id.
      if (snippetId && !new RegExp(`\\bid=["']${snippetId}["']`).test(lines[i])) continue;
      const end = hasClose ? htmlBlockEnd(lines, i, tag) : i;
      const start = i + 1;
      const endLine = end + 1;
      return {
        action: 'replace', startLine: start, endLine: endLine,
        anchor: lines.slice(start - 1, endLine).join('\n'),
        reason: `Found existing <${tag}${snippetId ? ` id="${snippetId}"` : ''}> — replacing that element.`,
        confidence: 80, code
      };
    }
    // No matching element to replace -> it's a NEW element. Offline can't infer
    // the right spot, so fall through to append (use an API key for smart placement).
    return {
      action: 'append', startLine: null, endLine: null, anchor: null,
      reason: `New <${tag}> element — appending to the end (set an API key for precise placement).`, confidence: 45, code
    };
  }

  // 1) Pull a likely identifier out of the snippet's first line.
  const idMatch =
    first.match(/(?:function|class|def|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/) ||
    first.match(/([A-Za-z_$][\w$]*)\s*(?:=|:)\s*(?:async\s*)?(?:function|\()/) ||
    first.match(/\bid=["']([\w-]+)["']/);
  const ident = idMatch ? idMatch[1] : null;

  // 2) If that identifier already exists, replace its whole block.
  if (ident) {
    const declRe = new RegExp(`\\b(?:function|class|def|const|let|var|interface|type|enum)\\b[^\\n]*\\b${ident}\\b|\\b${ident}\\b\\s*[:=]`);
    for (let i = 0; i < lines.length; i++) {
      if (declRe.test(lines[i])) {
        const start = i + 1;
        const end = blockEnd(lines, i) + 1;
        return {
          action: 'replace', startLine: start, endLine: end,
          anchor: lines.slice(start - 1, end).join('\n'),
          reason: `Found existing "${ident}" — replacing its definition.`, confidence: 78, code
        };
      }
    }
  }

  // 3) Import/require lines go after the last import.
  if (/^\s*(import|from|#include|require\()/.test(first)) {
    let lastImport = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(import|from|#include)\b|require\(/.test(lines[i])) lastImport = i + 1;
    }
    return {
      action: 'insert_after', startLine: lastImport, endLine: null,
      anchor: lines[lastImport - 1] || null,
      reason: 'Import detected — placing with the other imports.', confidence: 70, code
    };
  }

  // 4) Otherwise append at the end of the file.
  return {
    action: 'append', startLine: null, endLine: null, anchor: null,
    reason: 'No matching definition — appending to the end of the file.', confidence: 55, code
  };
}

// Find the line index of the matching </tag> for an element opening at startIdx,
// accounting for nested elements of the same tag.
function htmlBlockEnd(lines, startIdx, tag) {
  const openRe = new RegExp(`<${tag}\\b`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    depth += (lines[i].match(openRe) || []).length;
    depth -= (lines[i].match(closeRe) || []).length;
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

// Find the end index of a brace/indentation block starting at `startIdx`.
function blockEnd(lines, startIdx) {
  const opens = (lines[startIdx].match(/{/g) || []).length;
  const closes = (lines[startIdx].match(/}/g) || []).length;
  if (opens > 0) {
    let depth = opens - closes;
    if (depth <= 0) return startIdx;
    for (let i = startIdx + 1; i < lines.length; i++) {
      depth += (lines[i].match(/{/g) || []).length;
      depth -= (lines[i].match(/}/g) || []).length;
      if (depth <= 0) return i;
    }
    return lines.length - 1;
  }
  // No braces (e.g. Python): walk until indentation returns to base level.
  const baseIndent = (lines[startIdx].match(/^\s*/) || [''])[0].length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const ind = (lines[i].match(/^\s*/) || [''])[0].length;
    if (ind <= baseIndent) return i - 1;
  }
  return lines.length - 1;
}

// ─── Local Command Interpreter (no API key needed) ──────────────────────────────
// Handles the common "remove / delete" instructions directly against the file.
function localCommand(instruction, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { action: 'none', reason: 'No target file — pick a folder or file first.', confidence: 20, code: '' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const instr = instruction.toLowerCase();
  const isRemove = /\b(remove|delete|erase|drop|strip)\b/.test(instr);

  if (isRemove) {
    let del = [];
    let label = '';

    if (/heading|header|\bh[1-6]\b|<h[1-6]/.test(instr)) {
      // Remove heading tags (single-line <h1>..</h6>)
      del = lines.map((l, i) => /<h[1-6][\s>]/i.test(l) ? i : -1).filter(i => i >= 0);
      label = 'heading line(s)';
    } else {
      // Remove "this text X" / quoted phrase / trailing target phrase.
      const q = instruction.match(/["'`]([^"'`]+)["'`]/);
      let needle = q ? q[1]
        : instruction.replace(/.*\b(remove|delete|erase|drop|strip)\b\s*(this\s+|that\s+|the\s+|all\s+|every\s+)?(text|line|lines|word|words|element|tag|comment|comments)?\s*/i, '').trim();
      needle = needle.replace(/^["'`]+|["'`.]+$/g, '').trim();
      if (needle && needle.length > 1) {
        del = lines.map((l, i) => l.toLowerCase().includes(needle.toLowerCase()) ? i : -1).filter(i => i >= 0);
        label = `line(s) containing "${needle}"`;
      }
    }

    if (del.length) {
      const compound = /\b(add|insert|create|append)\b/.test(instr);
      return {
        action: 'delete',
        deleteLines: del.map(i => i + 1),
        reason: `Removing ${del.length} ${label}.` + (compound ? ' (The “add” part needs an API key.)' : ''),
        confidence: compound ? 60 : 82,
        code: ''
      };
    }
    return { action: 'none', reason: 'Nothing matched to remove. Add an API key for smarter edits.', confidence: 20, code: '' };
  }

  // add / change / refactor etc. can't be done reliably offline.
  return { action: 'none', reason: 'This edit needs an API key (Settings) so the AI can apply it precisely.', confidence: 15, code: '' };
}

// ─── AI Command (full edit via LLM) ─────────────────────────────────────────────
async function aiCommand(instruction, filePath, selectedModelId) {
  if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'Pick a target file first.' };
  const content = fs.readFileSync(filePath, 'utf8');

  const systemPrompt = `You are a precise code editor. You receive an INSTRUCTION and the FULL current file. Apply ONLY what the instruction asks, and nothing else.

Hard rules:
- Return ONLY valid JSON, no markdown, no commentary.
- Do NOT add comments, documentation, or explanations to the code unless explicitly told to.
- Preserve every unrelated line exactly as-is.
- Return the COMPLETE file in "content" — never truncate or use placeholders like "// ... rest unchanged".

Response format:
{
  "action": "rewrite",
  "content": "<the ENTIRE updated file, verbatim>",
  "reason": "<one short sentence>",
  "confidence": <0-100>
}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `INSTRUCTION:\n${instruction}\n\nFULL FILE (${path.basename(filePath)}):\n${content}` }
  ];

  try {
    const aiResult = await callAI(selectedModelId, messages, true);
    if (!aiResult.success) return { success: false, error: aiResult.error };

    const data = aiResult.data;
    const usg = data.usage || {};
    const tokensUsed = usg.total_tokens || 0;
    usageData.totalTokens += tokensUsed;
    usageData.totalRequests += 1;
    usageData.history.unshift({
      id: Date.now(), timestamp: new Date().toISOString(), model: aiResult.modelUsed || savedSettings.model,
      tokens: tokensUsed, snippet: instruction.slice(0, 80), file: path.basename(filePath)
    });
    if (usageData.history.length > 50) usageData.history = usageData.history.slice(0, 50);
    saveUsage(usageData);
    // Log to cloud (fire-and-forget)
    logUsageToCloud({
      model:       aiResult.modelUsed || savedSettings.model,
      tokensIn:    usg.prompt_tokens     || 0,
      tokensOut:   usg.completion_tokens || 0,
      tokensTotal: tokensUsed,
      promptText:  instruction,
      filePath,
    });

    let result;
    try { result = JSON.parse(data.choices[0].message.content); }
    catch (e) { return { success: false, error: 'AI returned an unreadable response.' }; }

    if (typeof result.content !== 'string') return { success: false, error: 'AI did not return updated file content.' };
    result.action = 'rewrite';
    if (result.confidence == null) result.confidence = 75;
    return { success: true, result, tokensUsed, modelUsed: aiResult.modelUsed };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Core AI Analyze + Apply ───────────────────────────────────────────────────

ipcMain.handle('snippet:analyze', async (_, { code, filePath, selectedModelId }) => {
  const raw = (code || '').trim();
  if (!raw || raw.startsWith('//')) return { success: false, error: 'Nothing to analyze.' };

  // ── Full-file replace ("replace the whole file with this …" / full document) ──
  const replace = parseReplaceCommand(raw);
  if (replace) {
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: true, local: true, tokensUsed: 0,
        result: { action: 'none', reason: 'Pick a target file first, then Analyze to overwrite it.', confidence: 20, code: '' }
      };
    }
    return {
      success: true, local: true, tokensUsed: 0,
      result: { action: 'rewrite', content: replace.content, reason: replace.reason, confidence: 96 }
    };
  }

  // ── Natural-language instruction → edit command ──
  if (looksLikeInstruction(raw)) {
    const hasModels = (savedSettings.modelRanking || []).some(m => m.enabled !== false && m.apiKey);
    if (!savedSettings.apiKey && !hasModels) {
      return { success: true, result: localCommand(raw, filePath), tokensUsed: 0, local: true };
    }
    return await aiCommand(raw, filePath, selectedModelId);
  }

  // ── Code snippet → placement. Clean off any AI prose/fences first. ──
  const cleaned = cleanSnippet(raw) || raw;

  // No API key and no models configured? Fall back to local heuristic.
  const hasModels = (savedSettings.modelRanking || []).some(m => m.enabled !== false && m.apiKey);
  if (!savedSettings.apiKey && !hasModels) {
    return { success: true, result: localAnalyze(cleaned, filePath), tokensUsed: 0, local: true };
  }

  // Save the editor's unsaved changes before we read the file.
  // This ensures the AI analyses the true current content, and by apply time
  // VS Code has no dirty state → no "Resolve save conflict" dialog.
  await forceEditorSave();

  // Read the full file so AI can search it like a human would
  let fileContent = '';
  if (filePath && fs.existsSync(filePath)) {
    try { fileContent = fs.readFileSync(filePath, 'utf8'); } catch (e) { /* skip */ }
  }

  // SEARCH/REPLACE approach — no line numbers. The AI returns one or more edits,
  // one per location that actually changes, finding each block verbatim.
  const systemPrompt = `You are a code editor. You receive a CODE SNIPPET and the FULL FILE it belongs to.
Produce surgical SEARCH/REPLACE edits so the snippet's changes land in the right places.

PLACEMENT COMMENTS — HIGHEST PRIORITY:
If the snippet contains a comment like "#add after B", "// insert after foo", "#place after X", "// after line X", or similar, that comment is a PLACEMENT DIRECTIVE. You MUST insert the code (without the comment) immediately after the line that matches the directive, nowhere else. The directive overrides any other placement logic.
Example: snippet = "C = input('hi') #add after B" and file has "B = int(input('age'))"
→ search: "B = int(input('age'))", replace: "B = int(input('age'))\nC = input('hi')"

STRICT RULES:
1. Return an "edits" array. Use the FEWEST edits that cleanly express the change. If several changes sit inside the same small parent element (e.g. one <main>, one <ul>, one function), return that parent as ONE edit rather than many tiny ones. Only use separate edits for changes in genuinely separate, distant locations.
2. "search" must be copied VERBATIM from the file — exact existing block being changed. Copy enough lines to be unique, but no more than needed.
3. To MODIFY something that already exists (add styles/attributes, change text, restyle), set "search" to the EXISTING element and "replace" to the UPDATED element. NEVER insert a second copy of an element that already exists.
4. Only treat code as NEW (insert) when no matching element exists in the file. To insert, set "search" to the exact existing line it should go after and "replace" to that same line followed by the new code.
5. NEVER place anything after </body> or </html>. Never create duplicate ids.
6. "replace" content comes from the snippet — strip placement directive comments, do not add other comments or explanations.
7. Return ONLY valid JSON. No markdown, no prose outside JSON.

Response format:
{
  "edits": [
    { "search": "<exact verbatim block from the file>", "replace": "<updated block>" }
  ],
  "reason": "<one sentence>",
  "confidence": <0-100>
}`;

  // Probe a search block against the real file: 'ok' | 'notfound' | 'multiple' | 'empty'.
  const probe = (search) => {
    const res = applySearchReplace(fileContent, search, search);
    return res.ok ? 'ok' : res.error;
  };

  let totalTokens = 0;
  let lastModelUsed = null;

  // One model round-trip → normalized edits[]. `feedback` lets us send a
  // corrective message on retries.
  const askModel = async (feedback) => {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `SNIPPET (insert/replace with this — do not modify):\n\`\`\`\n${cleaned}\n\`\`\`\n\nFULL FILE (${path.basename(filePath || 'unknown')}):\n\`\`\`\n${fileContent}\n\`\`\`` }
    ];
    if (feedback) messages.push({ role: 'user', content: feedback });

    const aiResult = await callAI(selectedModelId, messages, true);
    if (!aiResult.success) throw new Error(aiResult.error);
    if (aiResult.modelUsed) lastModelUsed = aiResult.modelUsed;
    const data = aiResult.data;
    totalTokens += (data.usage || {}).total_tokens || 0;

    let parsed;
    try { parsed = JSON.parse(data.choices[0].message.content); }
    catch (e) { return { edits: [], confidence: 0, reason: '' }; }

    let edits = [];
    if (Array.isArray(parsed.edits)) {
      edits = parsed.edits.filter(e => e && e.search).map(e => ({ search: e.search, replace: (e.replace != null ? e.replace : cleaned) }));
    } else if (parsed.search) {
      let replace = parsed.replace != null ? parsed.replace : cleaned;
      if (parsed.action === 'insert_after') replace = parsed.search + '\n' + cleaned;
      edits = [{ search: parsed.search, replace }];
    }
    return { edits, confidence: parsed.confidence == null ? 75 : parsed.confidence, reason: parsed.reason || '' };
  };

  try {
    let { edits, confidence, reason } = await askModel();

    const verify = (list) => list.map((e) => ({ e, status: probe(e.search) }));
    let checked = verify(edits);
    let bad = checked.filter(c => c.status !== 'ok');

    // Self-correct: feed the failed search blocks back and let the model fix them.
    // Up to 2 corrective passes — this is what removes the "retry 4 times" loop.
    let pass = 0;
    while (bad.length && pass < 2) {
      pass++;
      const feedback =
        `Some "search" blocks from your last answer are wrong. Return the COMPLETE corrected edits array again, fixing these:\n` +
        bad.map(c => c.status === 'multiple'
          ? `- Matched MULTIPLE places — include more surrounding lines so it is unique:\n${c.e.search}`
          : `- NOT found in the file — copy it EXACTLY from the FULL FILE above, character for character:\n${c.e.search}`
        ).join('\n') +
        `\nEvery "search" must be copied verbatim from the file shown above.`;
      const retry = await askModel(feedback);
      if (retry.edits.length) { edits = retry.edits; confidence = retry.confidence; reason = retry.reason || reason; }
      checked = verify(edits);
      bad = checked.filter(c => c.status !== 'ok');
    }

    const good = checked.filter(c => c.status === 'ok').map(c => c.e);

    // Log usage once for the whole analyze (including any corrective calls).
    usageData.totalTokens += totalTokens;
    usageData.totalRequests += 1;
    usageData.history.unshift({
      id: Date.now(), timestamp: new Date().toISOString(), model: lastModelUsed || savedSettings.model,
      tokens: totalTokens, snippet: cleaned.slice(0, 80) + (cleaned.length > 80 ? '...' : ''),
      file: filePath ? path.basename(filePath) : 'Unknown'
    });
    if (usageData.history.length > 50) usageData.history = usageData.history.slice(0, 50);
    saveUsage(usageData);
    // Log to cloud (fire-and-forget)
    logUsageToCloud({
      model:       lastModelUsed || savedSettings.model,
      tokensIn:    0,
      tokensOut:   0,
      tokensTotal: totalTokens,
      promptText:  cleaned,
      filePath:    filePath || '',
    });

    // Nothing the model produced matches the file → offline fallback.
    if (!good.length) {
      const fallback = localAnalyze(cleaned, filePath);
      fallback.reason = 'AI could not produce edits that match the file — used offline placement.';
      return { success: true, result: fallback, tokensUsed: totalTokens, local: true };
    }

    const result = {
      action: 'edits',
      edits: good,
      code: cleaned,
      search: good[0].search,        // keep first hunk visible for the renderer preview
      replace: good[0].replace,
      confidence,
      reason: bad.length
        ? `${reason || 'Prepared edits'} — note: ${bad.length} change(s) couldn't be matched and were skipped.`
        : (reason || `Prepared ${good.length} edit(s), all verified against the file.`)
    };
    return { success: true, result, tokensUsed: totalTokens, partial: bad.length > 0, modelUsed: lastModelUsed };

  } catch (err) {
    const fallback = localAnalyze(cleaned, filePath);
    fallback.reason = `${err.message} — used offline placement instead.`;
    return { success: true, result: fallback, tokensUsed: totalTokens, local: true };
  }
});

// Apply ONE search/replace edit to a string. Exact match first, then
// whitespace-tolerant (ignore leading/trailing space, then collapse internal
// runs), skipping blank lines on both sides. Re-indents the replacement to fit.
// Returns { ok, content } or { ok:false, error:'notfound'|'multiple'|'empty' }.
function applySearchReplace(fileContent, searchBlock, replaceBlock) {
  const nl = (s) => (s || '').replace(/\r\n/g, '\n');
  fileContent = nl(fileContent); searchBlock = nl(searchBlock); replaceBlock = nl(replaceBlock);
  if (!searchBlock.trim()) return { ok: false, error: 'empty' };

  const fileLines = fileContent.split('\n');
  const searchLines = searchBlock.split('\n');

  const lineStartOffset = (idx) => { let o = 0; for (let k = 0; k < idx; k++) o += fileLines[k].length + 1; return o; };

  const reindentBlock = (block, indent) => {
    const ls = block.split('\n');
    const firstNonEmpty = ls.find(l => l.trim() !== '') || '';
    const base = (firstNonEmpty.match(/^[ \t]*/) || [''])[0];
    return ls.map(l => {
      if (l.trim() === '') return '';
      const stripped = l.startsWith(base) ? l.slice(base.length) : l.replace(/^[ \t]*/, '');
      return indent + stripped;
    }).join('\n');
  };

  const locate = (normalize) => {
    const s = searchLines.map(normalize).filter(x => x !== '');
    if (!s.length) return [];
    const found = [];
    for (let start = 0; start < fileLines.length; start++) {
      if (normalize(fileLines[start]) !== s[0]) continue;
      let fi = start, si = 0, end = start;
      while (si < s.length && fi < fileLines.length) {
        const nf = normalize(fileLines[fi]);
        if (nf === '') { fi++; continue; }       // skip blank lines in the file
        if (nf !== s[si]) break;
        end = fi; fi++; si++;
      }
      if (si === s.length) found.push([start, end]);
    }
    return found;
  };

  const exact = fileContent.indexOf(searchBlock);
  if (exact !== -1) {
    if (exact !== fileContent.lastIndexOf(searchBlock)) return { ok: false, error: 'multiple' };
    return { ok: true, content: fileContent.slice(0, exact) + replaceBlock + fileContent.slice(exact + searchBlock.length) };
  }

  let matches = locate(l => l.trim());
  if (matches.length === 0) matches = locate(l => l.trim().replace(/\s+/g, ' '));

  if (matches.length === 0) {
    // Last resort: anchor on the first AND last non-blank lines of the search
    // block (recovers when the AI dropped/added a line in the middle). Kept
    // conservative — both anchors must be unique and the span must be modest.
    const sNon = searchLines.map(l => l.trim()).filter(x => x !== '');
    if (sNon.length >= 2) {
      const firstHits = [], lastHits = [];
      fileLines.forEach((l, i) => {
        const t = l.trim();
        if (t === sNon[0]) firstHits.push(i);
        if (t === sNon[sNon.length - 1]) lastHits.push(i);
      });
      if (firstHits.length === 1 && lastHits.length === 1 && lastHits[0] >= firstHits[0]) {
        const sL = firstHits[0], eL = lastHits[0];
        if (eL - sL + 1 <= sNon.length * 3 + 5) {   // don't grab a huge region
          const indent = (fileLines[sL].match(/^[ \t]*/) || [''])[0];
          const reindented = reindentBlock(replaceBlock, indent);
          return { ok: true, content: fileContent.slice(0, lineStartOffset(sL)) + reindented + fileContent.slice(lineStartOffset(eL) + fileLines[eL].length) };
        }
      }
    }
    return { ok: false, error: 'notfound' };
  }
  if (matches.length > 1) return { ok: false, error: 'multiple' };

  const [startLine, endLine] = matches[0];
  const indent = (fileLines[startLine].match(/^[ \t]*/) || [''])[0];
  const reindented = reindentBlock(replaceBlock, indent);
  const startChar = lineStartOffset(startLine);
  const endChar = lineStartOffset(endLine) + fileLines[endLine].length;
  return { ok: true, content: fileContent.slice(0, startChar) + reindented + fileContent.slice(endChar) };
}

// Normalize any analyze result (AI edits[], legacy search/replace, offline
// anchor, rewrite, delete, append) into a single shape the loop understands.
function normalizeToEdits(r, aiPatch) {
  if (!r && aiPatch) {
    try { r = typeof aiPatch === 'string' ? JSON.parse(aiPatch) : aiPatch; } catch (e) { r = null; }
  }
  if (!r) return null;
  if (r.action === 'rewrite' && typeof r.content === 'string') return { mode: 'rewrite', content: r.content };
  if (r.action === 'delete' && Array.isArray(r.deleteLines)) return { mode: 'delete', deleteLines: r.deleteLines };

  const pick = (e) => ({ search: e.search, replace: (e.replace != null ? e.replace : (e.code != null ? e.code : '')) });
  if (Array.isArray(r.edits) && r.edits.length) return { mode: 'edits', edits: r.edits.filter(e => e && e.search).map(pick) };
  if (r.search != null && String(r.search).trim()) return { mode: 'edits', edits: [pick(r)] };

  // Offline localAnalyze shape (anchor + action).
  if (r.anchor != null && String(r.anchor).trim()) {
    if (r.action === 'insert_after') return { mode: 'edits', edits: [{ search: r.anchor, replace: r.anchor + '\n' + (r.code || '') }] };
    return { mode: 'edits', edits: [{ search: r.anchor, replace: (r.code || '') }] };
  }
  if (r.action === 'append') return { mode: 'append', code: r.code || '' };
  return null;
}

/**
 * Before writing to a file, save it inside any open VS Code / Cursor window so
 * the editor has no dirty state. That way VS Code silently reloads the file
 * after our write instead of showing the "Resolve save conflict" dialog.
 */
async function forceEditorSave() {
  if (process.platform !== 'win32') return;
  const os = require('os');
  const scriptPath = path.join(os.tmpdir(), '_codeply_save.ps1');
  // WScript.Shell AppActivate + SendKeys is the reliable way to send keys to
  // another app on Windows — it bypasses focus-stealing prevention that blocks
  // SetForegroundWindow from background processes.
  const script = [
    '$shell = New-Object -ComObject WScript.Shell',
    '$editors = @("Cursor","Code","VSCodium","code-insiders")',
    'foreach ($e in $editors) {',
    '  $p = Get-Process $e -EA 0 | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1',
    '  if (!$p) { continue }',
    '  $activated = $shell.AppActivate($p.Id)',
    '  Start-Sleep -Milliseconds 200',
    '  $shell.SendKeys("^s")',
    '  Start-Sleep -Milliseconds 350',
    '  break',
    '}',
  ].join('\r\n');
  try {
    fs.writeFileSync(scriptPath, script, 'utf8');
    await new Promise((res) => {
      exec(`powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 4000 }, () => res());
    });
    await new Promise(r => setTimeout(r, 150));
  } catch (e) {
    console.warn('[Apply] forceEditorSave skipped:', e.message);
  }
}

ipcMain.handle('snippet:apply-to-file', async (_, { filePath, aiPatch, result: resultObj }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'Target file path does not exist or is inaccessible.' };
    }

    const r = resultObj || (typeof aiPatch === 'object' ? aiPatch : null);
    const plan = normalizeToEdits(r, aiPatch);
    if (!plan) return { success: false, error: 'No patch data received.' };

    const original = fs.readFileSync(filePath, 'utf8');

    // Atomic write: write to a temp file then rename over the original.
    const commit = (content) => {
      const tmp = filePath + '.__codeply_tmp';
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, filePath);
      // Bring the Codeply popup back to front after stealing focus for Ctrl+S
      if (popupWindow && !popupWindow.isDestroyed()) popupWindow.focus();
    };

    // ── Full-file rewrite ──
    if (plan.mode === 'rewrite') {
      if (!plan.content.trim()) return { success: false, error: 'No content to write.' };
      commit(plan.content);
      return { success: true, msg: 'Full file rewrite applied.' };
    }

    // ── Delete lines ──
    if (plan.mode === 'delete') {
      const lines = original.split('\n');
      const drop = new Set(plan.deleteLines.map(n => n - 1));
      commit(lines.filter((_, i) => !drop.has(i)).join('\n'));
      return { success: true, msg: `Deleted ${plan.deleteLines.length} line(s).` };
    }

    // ── Append to end ──
    if (plan.mode === 'append') {
      const base = original.replace(/\r\n/g, '\n');
      const sep = base.endsWith('\n') ? '' : '\n';
      commit(base + sep + plan.code.replace(/\r\n/g, '\n') + '\n');
      return { success: true, msg: 'Appended to end of file.' };
    }

    // ── One or more surgical edits — ALL-OR-NOTHING ──
    if (!plan.edits.length) return { success: false, error: 'No edits to apply.' };

    let working = original.replace(/\r\n/g, '\n');
    for (let i = 0; i < plan.edits.length; i++) {
      const { search, replace } = plan.edits[i];
      const res = applySearchReplace(working, search, replace);
      if (!res.ok) {
        const label = plan.edits.length > 1 ? `Change ${i + 1} of ${plan.edits.length}` : 'The change';
        const why = res.error === 'multiple'
          ? 'matches more than one place — ask the AI to include a few more surrounding lines so the target is unique'
          : res.error === 'empty'
            ? 'had an empty search block'
            : "wasn't found in the file — it may have changed since the AI read it, so re-analyze";
        // Nothing is written: the file is left exactly as it was (no half-applied mess).
        return { success: false, error: `${label} ${why}. No changes were written.` };
      }
      working = res.content;
    }

    commit(working);
    return {
      success: true,
      msg: plan.edits.length > 1 ? `Applied ${plan.edits.length} changes cleanly.` : 'Surgical patch applied cleanly.'
    };

  } catch (globalErr) {
    console.error("Patch application handler encountered a critical error:", globalErr);
    return { success: false, error: `Internal Engine Error: ${globalErr.message}` };
  }
});

// ─── Supabase Auth IPC ─────────────────────────────────────────────────────────

function formatSupabaseAuthError(raw, context = 'login') {
  let msg = raw?.message || raw?.msg || String(raw || '');
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (parsed?.msg) msg = parsed.msg;
    if (parsed?.message) msg = parsed.message;
  } catch { }
  const lower = msg.toLowerCase();
  if (lower.includes('unsupported provider') || lower.includes('provider is not enabled')) {
    return 'Browser sign-in is not enabled yet. Please use email sign-in below.';
  }
  if (lower.includes('redirect_uri_mismatch')) {
    return 'Google OAuth redirect URI is misconfigured. In Google Cloud Console, add this Authorized redirect URI: https://zswkhfkfseclgadhvobg.supabase.co/auth/v1/callback';
  }
  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Incorrect email or password.';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'An account with this email already exists. Try signing in.';
  }
  if (lower.includes('signup') && lower.includes('disabled')) {
    return 'New account registration is disabled. Contact support.';
  }
  if (context === 'signup') return msg || 'Failed to create account.';
  if (context === 'oauth') return msg || 'Failed to start browser sign-in.';
  return msg || 'Failed to sign in.';
}

// Friendly errors for the 6-digit email code (OTP) step.
function formatOtpError(raw) {
  let msg = typeof raw === 'string' ? raw : (raw?.message || raw?.msg || '');
  try { const p = JSON.parse(msg); msg = p.msg || p.message || msg; } catch {}
  const lower = String(msg).toLowerCase();
  if (lower.includes('expired')) return 'That code has expired. Tap “Resend code” to get a fresh one.';
  if (lower.includes('rate') || lower.includes('too many') || lower.includes('seconds')) {
    return 'Please wait a moment before requesting another code.';
  }
  if (lower.includes('invalid') || lower.includes('token') || lower.includes('otp')) {
    return 'Incorrect code. Double-check the 6 digits and try again.';
  }
  return msg || 'Could not verify the code. Try again.';
}

async function startOAuthSignIn(provider) {
  await ensureSupabaseReady();
  if (!supabase) return { success: false, error: 'Supabase not ready' };
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: 'codeply://auth-callback', skipBrowserRedirect: true }
    });
    if (error) return { success: false, error: formatSupabaseAuthError(error, 'oauth') };
    if (!data?.url) return { success: false, error: 'Could not start browser sign-in.' };
    await shell.openExternal(data.url);
    return { success: true };
  } catch (e) { return { success: false, error: formatSupabaseAuthError(e, 'oauth') }; }
}

ipcMain.handle('auth:sign-in-browser', async () => startOAuthSignIn('google'));

ipcMain.handle('auth:sign-in-google', async () => startOAuthSignIn('google'));

ipcMain.handle('auth:sign-in-github', async () => startOAuthSignIn('github'));

// Email + password login is two-factor: validate the password, then email a
// fresh 6-digit code. The user isn't logged in until they verify that code.
ipcMain.handle('auth:sign-in-email', async (_, { email, password }) => {
  await ensureSupabaseReady();
  if (!supabase) return { success: false, error: 'Supabase not ready' };
  try {
    // Step 1 — validate the password.
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: formatSupabaseAuthError(error, 'login') };
    // Discard the password-only session; login completes only after OTP verify.
    try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
    // Step 2 — email a 6-digit code.
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email, options: { shouldCreateUser: false }
    });
    if (otpErr) return { success: false, error: formatOtpError(otpErr) };
    return { success: true, needsOtp: true, email, mode: 'login' };
  } catch (e) { return { success: false, error: formatSupabaseAuthError(e, 'login') }; }
});

// Sign up, then require the emailed 6-digit code before the account is active.
ipcMain.handle('auth:sign-up-email', async (_, { email, password, name }) => {
  await ensureSupabaseReady();
  if (!supabase) return { success: false, error: 'Supabase not ready' };
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name || email.split('@')[0] } }
    });
    if (error) return { success: false, error: formatSupabaseAuthError(error, 'signup') };

    // Supabase returns an empty-identities user when email is already registered
    if (data.user && (!data.user.identities || data.user.identities.length === 0)) {
      return { success: false, error: 'An account with this email already exists. Try signing in.' };
    }

    const niceName = name || (email ? email.split('@')[0] : '');

    // If a session came back, email confirmation is OFF on the project. We still
    // want a 6-digit code, so drop the session and email a login code instead.
    if (data.session) {
      try { await supabase.auth.signOut({ scope: 'local' }); } catch {}
      try { await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } }); } catch {}
      return { success: true, needsOtp: true, email, mode: 'login', name: niceName };
    }

    // Normal path: a confirmation email containing the 6-digit token was sent.
    return { success: true, needsOtp: true, email, mode: 'signup', name: niceName };
  } catch (e) { return { success: false, error: formatSupabaseAuthError(e, 'signup') }; }
});

// Verify the 6-digit code for either signup confirmation or login 2FA.
ipcMain.handle('auth:verify-otp', async (_, { email, token, mode }) => {
  await ensureSupabaseReady();
  if (!supabase) return { success: false, error: 'Supabase not ready' };
  const code = String(token || '').replace(/\s+/g, '');
  if (!email || !code) return { success: false, error: 'Enter the 8-digit code we emailed you.' };
  try {
    const primaryType = mode === 'signup' ? 'signup' : 'email';
    let { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: primaryType });
    // Some projects accept signup confirmations under the 'email' type — retry once.
    if (error) {
      const fallbackType = mode === 'signup' ? 'email' : 'signup';
      const retry = await supabase.auth.verifyOtp({ email, token: code, type: fallbackType });
      if (!retry.error) { data = retry.data; error = null; }
    }
    if (error) return { success: false, error: formatOtpError(error) };
    const user = data?.user || data?.session?.user;
    if (!user) return { success: false, error: 'Could not verify the code. Please try again.' };
    const mapped = await persistAuthUser(user);
    return { success: true, user: mapped };
  } catch (e) { return { success: false, error: formatOtpError(e) }; }
});

// Resend the 6-digit code.
ipcMain.handle('auth:resend-otp', async (_, { email, mode }) => {
  await ensureSupabaseReady();
  if (!supabase) return { success: false, error: 'Supabase not ready' };
  if (!email) return { success: false, error: 'Missing email address.' };
  try {
    if (mode === 'signup') {
      const { error } = await supabase.auth.resend({ type: 'signup', email });
      if (error) {
        // Fall back to an OTP email if the user is already confirmed.
        const alt = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (alt.error) return { success: false, error: formatOtpError(error) };
      }
    } else {
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) return { success: false, error: formatOtpError(error) };
    }
    return { success: true };
  } catch (e) { return { success: false, error: formatOtpError(e) }; }
});

ipcMain.handle('auth:sign-out', async () => {
  if (!supabase) return { success: false };
  try {
    await supabase.auth.signOut();
    // Clear user identity AND wipe the API key locally — it lives in the cloud,
    // so the next user who logs in gets their own key, not the previous user's.
    // Wipe ALL account-specific settings so the next user gets a clean slate.
    savedSettings.user         = null;
    savedSettings.apiKey       = '';
    savedSettings.modelRanking = [];
    savedSettings.provider     = 'openrouter';
    savedSettings.model        = '';
    savedSettings.tokenCap     = 0;
    persistSettings();
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('auth:get-session', async () => {
  await ensureSupabaseReady();
  if (!supabase) return null;
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session) return null;
    // Restore cloud settings every time the session is resumed (app restart / re-open)
    await fetchCloudSettings(session.user.id);
    return sessionUserFromAuth(session.user);
  } catch { return null; }
});

ipcMain.handle('subscription:check', async () => {
  if (!supabase) return { allowed: true, reason: 'no-supabase' };
  try {
    // 1. Global kill switch
    const { data: cfg } = await supabase.from('app_config').select('value').eq('key', 'kill_switch').single();
    if (cfg?.value === 'true') {
      return { allowed: false, reason: 'kill_switch', message: 'Codeply now required a subscription only 10$ per month.' };
    }
    // 2. Per-user subscription
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { allowed: true, reason: 'guest' }; // guests allowed
    const { data: profile } = await supabase.from('profiles').select('subscribed, plan').eq('id', session.user.id).single();
    if (profile && profile.subscribed === false) {
      return { allowed: false, reason: 'not_subscribed', message: 'Subscribe to Codeply Pro to continue.' };
    }
    return { allowed: true, reason: 'ok', plan: profile?.plan || 'free' };
  } catch (e) {
    return { allowed: true, reason: 'error' }; // fail-open so a DB hiccup doesn't lock users out
  }
});

ipcMain.handle('file:browse', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(popupWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Code Files', extensions: ['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'cs', 'php', 'rb', 'html', 'css', 'json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('file:read', (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return { content: fs.readFileSync(filePath, 'utf8'), name: path.basename(filePath) };
  } catch (e) { return null; }
});

// ─── Startup-entry cleanup ──────────────────────────────────────────────────────
// A previous `electron .` dev run registered electron.exe itself in the Windows
// Run key (shows as "Electron" in Startup apps). Scan the Run key and delete only
// entries that point at a dev electron.exe — never the real Codeply entry.
function cleanupStrayStartupEntries() {
  if (process.platform !== 'win32') return;
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  exec(`reg query "${RUN_KEY}"`, (err, stdout) => {
    if (err || !stdout) return;
    stdout.split(/\r?\n/).forEach((line) => {
      // Value lines look like:  "    Name    REG_SZ    C:\path\to\exe ..."
      const m = line.match(/^\s*(\S.*?)\s+REG_\w+\s+(.+)$/);
      if (!m) return;
      const name = m[1].trim();
      const data = m[2].toLowerCase();
      const isDevElectron =
        data.includes('node_modules\\electron') ||
        data.includes('electron\\dist\\electron.exe');
      // Guard: never touch the legitimate Codeply startup entry.
      if (isDevElectron && !data.includes('codeply')) {
        exec(`reg delete "${RUN_KEY}" /v "${name}" /f`, () => {});
      }
    });
  });
}

// ─── App Boot ──────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Launch-at-login: ONLY register the real packaged Codeply build.
  // Running `electron .` in dev would otherwise register electron.exe itself,
  // which is why a stray "Electron" entry showed up in Startup apps.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  }
  // Remove any leftover dev "Electron" startup entry from earlier runs.
  cleanupStrayStartupEntries();
  app.on('before-quit', () => { app.isQuiting = true; });

  const launchUrl = getDeepLinkFromArgv();
  if (launchUrl) pendingAuthUrl = launchUrl;

  await ensureSupabaseReady();    // boot Supabase first so IPC handlers have a client
  createPopupWindow();
  createDashboardWindow();
  createTray();
  await flushPendingAuthCallback();

  startClipboardWatch();   // code-only clipboard sync every 10s
  startFolderWatch();      // auto-detect the file you're editing

  // ── Auto-updater (fully in-app — no native OS notifications) ───────────────
  // Only runs in packaged builds (not during `npm start`). We drive the whole
  // flow from the in-app update page in the dashboard: check → download (with a
  // progress bar) → restart to install. checkForUpdatesAndNotify() is NOT used
  // because it pops a Windows notification that errors when the app is open.
  if (app.isPackaged) {
    autoUpdater.autoDownload = false;          // download is triggered from the UI
    autoUpdater.autoInstallOnAppQuit = false;  // install/restart is user-driven
    autoUpdater.allowDowngrade = false;

    const sendToDash = (channel, payload) => {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        try { dashboardWindow.webContents.send(channel, payload); } catch {}
      }
    };

    autoUpdater.on('update-available', (info) => {
      sendToDash('update:available', { version: info?.version || '' });
    });
    autoUpdater.on('update-not-available', () => {
      sendToDash('update:none', {});
    });
    autoUpdater.on('download-progress', (p) => {
      sendToDash('update:progress', {
        percent: Math.round(p?.percent || 0),
        transferred: p?.transferred || 0,
        total: p?.total || 0,
        bytesPerSecond: p?.bytesPerSecond || 0,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      sendToDash('update:downloaded', { version: info?.version || '' });
    });
    autoUpdater.on('error', (err) => {
      sendToDash('update:error', { message: (err && err.message) || String(err) });
    });

    // Silent background check on boot — only the in-app page reacts.
    autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] check failed:', e.message));
  }

  const hotkey = savedSettings.hotkey || 'Alt+C';
  globalShortcut.register(hotkey, togglePopup);
});

app.on('will-quit', () => {
  app.isQuiting = true;
  globalShortcut.unregisterAll();
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (watchTimer) clearInterval(watchTimer);
});
app.on('window-all-closed', () => { /* keep alive in tray */ });