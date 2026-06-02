/**
 * Codeply AI - Secure Preload Context Bridge
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codeply', {
  // Snippet events
  onSnippetUpdate(cb) { ipcRenderer.on('snippet:update', (_, s) => cb(s)); },

  // Auto-detected active file (read from focused IDE window title)
  onActiveFile(cb) { ipcRenderer.on('active-file:update', (_, f) => cb(f)); },
  requestActiveFile() { ipcRenderer.send('active-file:request'); },

  // Popup actions
  dismiss() { return ipcRenderer.invoke('popup:dismiss'); },
  minimize() { return ipcRenderer.invoke('popup:minimize'); },
  refreshSnippet() { ipcRenderer.send('refresh-clipboard'); },
  openDashboard() { return ipcRenderer.invoke('dashboard:open'); },

  // AI core
  analyzeSnippet(payload) { return ipcRenderer.invoke('snippet:analyze', payload); },
  applyToFile(payload) { return ipcRenderer.invoke('snippet:apply-to-file', payload); },

  // File ops
  readFile(p) { return ipcRenderer.invoke('file:read', p); },

  // Settings
  getSettings() { return ipcRenderer.invoke('settings:get'); },
  saveSettings(s) { return ipcRenderer.invoke('settings:save', s); },

  // Usage
  getUsage() { return ipcRenderer.invoke('usage:get'); },
  resetUsage() { return ipcRenderer.invoke('usage:reset'); },

  // Dashboard window controls
  dashboardMinimize() { return ipcRenderer.invoke('dashboard:minimize'); },
  dashboardMaximize() { return ipcRenderer.invoke('dashboard:maximize'); },
  dashboardClose() { return ipcRenderer.invoke('dashboard:close'); },
  appQuit() { return ipcRenderer.invoke('app:quit'); },
});
