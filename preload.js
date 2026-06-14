/**
 * Codeply AI - Secure Preload Context Bridge
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codeply', {
  // Snippet events
  onSnippetUpdate(cb) { ipcRenderer.on('snippet:update', (_, s) => cb(s)); },

  // Active-file (auto-detection) events
  onActiveFile(cb) { ipcRenderer.on('active-file:update', (_, f) => cb(f)); },
  getWatch() { return ipcRenderer.invoke('watch:get'); },
  pickWatchFolder() { return ipcRenderer.invoke('watch:pick-folder'); },

  // Popup actions
  dismiss() { return ipcRenderer.invoke('popup:dismiss'); },
  minimize() { return ipcRenderer.invoke('popup:minimize'); },
  close() { return ipcRenderer.invoke('popup:close'); },
  refreshSnippet() { ipcRenderer.send('refresh-clipboard'); },
  openDashboard() { return ipcRenderer.invoke('dashboard:open'); },

  // AI core
  analyzeSnippet(payload) { return ipcRenderer.invoke('snippet:analyze', payload); },
  applyToFile(payload) { return ipcRenderer.invoke('snippet:apply-to-file', payload); },

  // File ops
  browseFile() { return ipcRenderer.invoke('file:browse'); },
  readFile(p) { return ipcRenderer.invoke('file:read', p); },

  // Settings
  getSettings() { return ipcRenderer.invoke('settings:get'); },
  saveSettings(s) { return ipcRenderer.invoke('settings:save', s); },
  onSettingsUpdated(cb) { ipcRenderer.on('settings:updated', (_, s) => cb(s)); },

  // Usage
  getUsage() { return ipcRenderer.invoke('usage:get'); },
  resetUsage() { return ipcRenderer.invoke('usage:reset'); },

  // Dashboard window controls
  dashboardMinimize() { return ipcRenderer.invoke('dashboard:minimize'); },
  dashboardMaximize() { return ipcRenderer.invoke('dashboard:maximize'); },
  dashboardClose() { return ipcRenderer.invoke('dashboard:close'); },
  appQuit() { return ipcRenderer.invoke('app:quit'); },
  openExternal(url) { return ipcRenderer.invoke('shell:open-external', url); },

  // ── Supabase Auth ──────────────────────────────────────────────────────────
  auth: {
    signInBrowser()        { return ipcRenderer.invoke('auth:sign-in-browser'); },
    signInGoogle()         { return ipcRenderer.invoke('auth:sign-in-google'); },
    signInGitHub()         { return ipcRenderer.invoke('auth:sign-in-github'); },
    signInEmail(creds)     { return ipcRenderer.invoke('auth:sign-in-email', creds); },
    signUpEmail(creds)     { return ipcRenderer.invoke('auth:sign-up-email', creds); },
    verifyOtp(payload)     { return ipcRenderer.invoke('auth:verify-otp', payload); },
    resendOtp(payload)     { return ipcRenderer.invoke('auth:resend-otp', payload); },
    signOut()              { return ipcRenderer.invoke('auth:sign-out'); },
    getSession()           { return ipcRenderer.invoke('auth:get-session'); },
    onCallback(cb)         { ipcRenderer.on('auth:callback', (_, data) => cb(data)); },
  },

  // ── Subscription / Paywall ─────────────────────────────────────────────────
  subscription: {
    check() { return ipcRenderer.invoke('subscription:check'); },
  },

  // ── Cloud history ───────────────────────────────────────────────────────────
  history: {
    getCloud()  { return ipcRenderer.invoke('history:get-cloud'); },
    getStats()  { return ipcRenderer.invoke('history:get-cloud-stats'); },
  },

  // ── App controls ────────────────────────────────────────────────────────────
  app: {
    restart() { return ipcRenderer.invoke('app:restart'); },
  },

  // ── Auto-updater (in-app update page) ───────────────────────────────────────
  updater: {
    check()    { return ipcRenderer.invoke('update:check'); },
    download() { return ipcRenderer.invoke('update:download'); },
    install()  { return ipcRenderer.invoke('update:install'); },
    onAvailable(cb)  { ipcRenderer.on('update:available',  (_, d) => cb(d)); },
    onNone(cb)       { ipcRenderer.on('update:none',       (_, d) => cb(d)); },
    onProgress(cb)   { ipcRenderer.on('update:progress',   (_, d) => cb(d)); },
    onDownloaded(cb) { ipcRenderer.on('update:downloaded', (_, d) => cb(d)); },
    onError(cb)      { ipcRenderer.on('update:error',      (_, d) => cb(d)); },
  },

  // ── AI events (model fallback notifications) ────────────────────────────────
  onModelFallback(cb) { ipcRenderer.on('ai:model-fallback', (_, d) => cb(d)); },
});
