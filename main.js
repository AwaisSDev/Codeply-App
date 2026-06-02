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
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');

let popupWindow;
let dashboardWindow;
let tray;

const configPath = path.join(app.getPath('userData'), 'codeply-config.json');
const usagePath = path.join(app.getPath('userData'), 'codeply-usage.json');

// ─── Config & Usage Persistence ───────────────────────────────────────────────

function loadSettings() {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) { console.error("Config load error:", e); }
  return { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: '', theme: 'dark', hotkey: 'CommandOrControl+Alt+B', user: null };
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

let savedSettings = loadSettings();
let usageData = loadUsage();

// ─── Popup Window ──────────────────────────────────────────────────────────────

function createPopupWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  popupWindow = new BrowserWindow({
    width: 380,
    height: 500,
    x: width - 400,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  popupWindow.hide();
}

// ─── Dashboard Window ──────────────────────────────────────────────────────────

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#eef0f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
}

// ─── Tray ──────────────────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'Favicon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); } else { createDashboardWindow(); } } },
    { label: 'Toggle Overlay', click: togglePopup },
    { type: 'separator' },
    { label: 'Quit Codeply', click: () => app.quit() }
  ]);
  tray.setToolTip('Codeply AI');
  tray.setContextMenu(contextMenu);
  tray.on('click', togglePopup);
}

function togglePopup() {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
  } else {
    const text = clipboard.readText();
    popupWindow.webContents.send('snippet:update', {
      text: text || '',
      preview: text || '',
      language: detectLanguage(text),
      lineCount: text ? text.split('\n').length : 0,
      summary: text ? 'Paste your AI code snippet then hit Analyze to find where it goes.' : 'Copy code to get started.'
    });
    popupWindow.show();
    popupWindow.focus();
    // Auto-detect the active editor file every time the overlay opens.
    sendActiveFile(popupWindow);
  }
}

// ─── Language Detection ────────────────────────────────────────────────────────

// ─── Active File Detection ──────────────────────────────────────────────────────
// Codeply auto-detects the file you're working on by reading the title of the
// currently-focused editor window. No manual file picking — the user just copies
// code, opens the overlay, and the target file is already locked in.

const CODE_EXT = ['js','jsx','ts','tsx','py','go','rs','java','cpp','cc','c','h','hpp','cs','php','rb','html','css','scss','json','vue','svelte','kt','swift','sql','sh','yml','yaml','md'];
const FILE_RE = /([^\\\/\s•|\u2014\u2013]+\.(?:js|jsx|ts|tsx|py|go|rs|java|cpp|cc|c|h|hpp|cs|php|rb|html|css|scss|json|vue|svelte|kt|swift|sql|sh|ya?ml|md))/i;

function ideNameFromTitle(title = '') {
  if (/Visual Studio Code/i.test(title)) return 'VS Code';
  if (/\bCursor\b/i.test(title)) return 'Cursor';
  if (/Windsurf/i.test(title)) return 'Windsurf';
  if (/IntelliJ/i.test(title)) return 'IntelliJ';
  if (/PyCharm/i.test(title)) return 'PyCharm';
  if (/WebStorm/i.test(title)) return 'WebStorm';
  if (/GoLand/i.test(title)) return 'GoLand';
  if (/Rider/i.test(title)) return 'Rider';
  if (/Sublime Text/i.test(title)) return 'Sublime';
  if (/\bZed\b/i.test(title)) return 'Zed';
  if (/Antigravity/i.test(title)) return 'Antigravity';
  if (/Neovim|nvim|\bvim\b/i.test(title)) return 'Vim';
  if (/Xcode/i.test(title)) return 'Xcode';
  if (/Visual Studio/i.test(title)) return 'Visual Studio';
  return 'Editor';
}

// Get window titles of the most relevant focused processes, cross-platform.
function getFocusedWindowTitles() {
  return new Promise((resolve) => {
    let cmd;
    if (process.platform === 'win32') {
      cmd = `powershell -NoProfile -Command "(Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Sort-Object CPU -desc | Select-Object -First 8).MainWindowTitle"`;
    } else if (process.platform === 'darwin') {
      // Title of the front window of the frontmost app (falls back to app name).
      cmd = `osascript -e 'tell application "System Events" to tell (first process whose frontmost is true) to get value of attribute "AXTitle" of front window'`;
    } else {
      cmd = `xdotool getactivewindow getwindowname`;
    }
    try {
      exec(cmd, { timeout: 2500, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve([]);
        resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean));
      });
    } catch (e) { resolve([]); }
  });
}

// Best-effort resolution of a bare filename to a full path on disk.
function shallowFind(root, fileName, maxDepth = 4, budget = { n: 4000 }) {
  if (!root || budget.n <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  const dirs = [];
  for (const ent of entries) {
    if (budget.n-- <= 0) return null;
    if (ent.isFile() && ent.name === fileName) return path.join(root, fileName);
    if (ent.isDirectory() && !/^(node_modules|\.git|dist|build|\.next|target|venv|__pycache__|\.idea|\.vscode)$/.test(ent.name)) {
      dirs.push(path.join(root, ent.name));
    }
  }
  if (maxDepth <= 0) return null;
  for (const d of dirs) {
    const found = shallowFind(d, fileName, maxDepth - 1, budget);
    if (found) return found;
  }
  return null;
}

// Find a directory with an exact name under `root` (depth-limited, budgeted).
function findDirNamed(root, dirName, maxDepth = 3, budget = { n: 3000 }) {
  if (!root || budget.n <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  const dirs = [];
  for (const ent of entries) {
    if (budget.n-- <= 0) return null;
    if (ent.isDirectory() && !/^(node_modules|\.git|dist|build|\.next|target|venv|__pycache__|\.idea|\.vscode|Library|AppData)$/.test(ent.name)) {
      if (ent.name === dirName) return path.join(root, ent.name);
      dirs.push(path.join(root, ent.name));
    }
  }
  if (maxDepth <= 0) return null;
  for (const d of dirs) {
    const found = findDirNamed(d, dirName, maxDepth - 1, budget);
    if (found) return found;
  }
  return null;
}

function resolveFilePath(fileName, titles, knownRoots = []) {
  const home = os.homedir();
  const COMMON = [process.cwd(), path.join(home, 'Projects'), path.join(home, 'projects'),
    path.join(home, 'dev'), path.join(home, 'code'), path.join(home, 'src'),
    path.join(home, 'Documents'), path.join(home, 'Desktop'), home];

  // 1. A title may already carry an absolute path (JetBrains, Vim, etc.)
  for (const t of titles) {
    const m = t.match(/([A-Za-z]:\\[^\s•|]+|\/[^\s•|]+)/);
    if (m && m[1].endsWith(fileName) && fs.existsSync(m[1])) return m[1];
  }
  // 2. Roots that worked before (persisted across launches).
  for (const root of knownRoots) {
    const found = shallowFind(root, fileName, 5);
    if (found) return found;
  }
  // 3. Folder-name hint from the title, e.g. "Test.h — myproject — Antigravity".
  const fileTitle = titles.find(t => FILE_RE.test(t));
  if (fileTitle) {
    const hints = fileTitle.split(/[—–\-|•›»]/).map(s => s.trim()).filter(s =>
      s && !FILE_RE.test(s) && !s.includes('.') && s.length < 40 &&
      !/code|cursor|antigravity|windsurf|intellij|pycharm|webstorm|goland|rider|sublime|\bzed\b|\bvim\b|xcode|visual studio|editor|untitled|workspace/i.test(s));
    for (const hint of hints) {
      for (const sr of COMMON) {
        const dir = findDirNamed(sr, hint, 3);
        if (dir) { const found = shallowFind(dir, fileName, 6); if (found) return found; }
      }
    }
  }
  // 4. Broad scan of common roots.
  for (const root of COMMON) {
    const found = shallowFind(root, fileName, 4);
    if (found) return found;
  }
  return null;
}

// Persist directories where files resolved, so future lookups are instant.
function rememberRoot(dir) {
  if (!dir) return;
  const roots = new Set(savedSettings.knownRoots || []);
  let d = dir;
  for (let i = 0; i < 2 && d; i++) { roots.add(d); const p = path.dirname(d); if (p === d) break; d = p; }
  savedSettings.knownRoots = [...roots].slice(-12);
  try { fs.writeFileSync(configPath, JSON.stringify(savedSettings, null, 2)); } catch (e) { /* ignore */ }
}

// Detect the active file and push it to the overlay renderer.
async function sendActiveFile(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const titles = await getFocusedWindowTitles();
    const fileTitle = titles.find(t => {
      const lc = t.toLowerCase();
      return CODE_EXT.some(ext => lc.includes('.' + ext)) && FILE_RE.test(t);
    });
    if (!fileTitle) { win.webContents.send('active-file:update', null); return; }

    const name = (fileTitle.match(FILE_RE) || [])[1] || null;
    if (!name) { win.webContents.send('active-file:update', null); return; }

    const ide = ideNameFromTitle(fileTitle);
    const fullPath = resolveFilePath(name, titles, savedSettings.knownRoots || []);
    let content = null;
    if (fullPath) {
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch (e) { /* unreadable */ }
      rememberRoot(path.dirname(fullPath));
    }

    win.webContents.send('active-file:update', { name, path: fullPath, content, ide });
  } catch (e) {
    win.webContents.send('active-file:update', null);
  }
}

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

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.on('refresh-clipboard', () => {
  const text = clipboard.readText();
  if (!popupWindow) return;
  popupWindow.webContents.send('snippet:update', {
    text: text || '',
    preview: text || '',
    language: detectLanguage(text),
    lineCount: text ? text.split('\n').length : 0,
    summary: text ? 'Ready to analyze. Hit Analyze to find the exact placement.' : 'Copy code to get started.'
  });
});

ipcMain.handle('settings:get', () => savedSettings);
// Renderer asks for a fresh active-file detection (e.g. on overlay load).
ipcMain.on('active-file:request', () => { if (popupWindow) sendActiveFile(popupWindow); });

ipcMain.handle('settings:save', async (_, settings) => {
  savedSettings = { ...savedSettings, ...settings };
  try { fs.writeFileSync(configPath, JSON.stringify(savedSettings, null, 2)); } catch (e) { console.error(e); }
  return { success: true };
});

ipcMain.handle('usage:get', () => usageData);

ipcMain.handle('usage:reset', () => {
  usageData = { totalTokens: 0, totalRequests: 0, sessions: [], history: [] };
  saveUsage(usageData);
  return { success: true };
});

ipcMain.handle('popup:dismiss', () => { if (popupWindow) popupWindow.hide(); });
ipcMain.handle('popup:minimize', () => { if (popupWindow) popupWindow.minimize(); });
ipcMain.handle('dashboard:open', () => {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.show(); dashboardWindow.focus(); }
  else createDashboardWindow();
});
ipcMain.handle('dashboard:minimize', () => { if (dashboardWindow) dashboardWindow.minimize(); });
ipcMain.handle('dashboard:maximize', () => {
  if (dashboardWindow) { dashboardWindow.isMaximized() ? dashboardWindow.unmaximize() : dashboardWindow.maximize(); }
});
ipcMain.handle('dashboard:close', () => { if (dashboardWindow) dashboardWindow.hide(); });
ipcMain.handle('app:quit', () => app.quit());

// ─── Core AI Analyze + Apply ───────────────────────────────────────────────────

ipcMain.handle('snippet:analyze', async (_, { code, filePath }) => {
  if (!code || code.trim().startsWith('//')) return { success: false, error: 'No code to analyze.' };
  if (!savedSettings.apiKey) return { success: false, error: 'Add your API key in Settings first.' };

  const url = savedSettings.provider === 'groq'
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://openrouter.ai/api/v1/chat/completions';

  let fileContext = '';
  if (filePath && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      fileContext = `\n\nTARGET FILE (${path.basename(filePath)}):\n` +
        lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
    } catch (e) { /* skip */ }
  }

  const systemPrompt = `You are a surgical code placement assistant. Your ONLY job is to determine WHERE the given code snippet should be inserted or replaced in the target file.

Rules:
- NEVER modify the code snippet itself. Return it exactly as given.
- Analyze the snippet and file to find the best placement.
- Return ONLY valid JSON, nothing else.

Response format:
{
  "action": "replace" | "insert_after" | "insert_before" | "append",
  "startLine": <number or null>,
  "endLine": <number or null>,
  "reason": "<one sentence explanation>",
  "confidence": <0-100>,
  "code": "<the exact original snippet, unchanged>"
}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${savedSettings.apiKey}` },
      body: JSON.stringify({
        model: savedSettings.model || 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `CODE SNIPPET TO PLACE:\n${code}${fileContext}` }
        ],
        response_format: { type: 'json_object' }
      })
    });

    const data = await response.json();
    if (!data.choices?.[0]) throw new Error(data.error?.message || 'API error');

    const usage = data.usage || {};
    const tokensUsed = usage.total_tokens || 0;
    usageData.totalTokens += tokensUsed;
    usageData.totalRequests += 1;
    usageData.history.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      model: savedSettings.model,
      tokens: tokensUsed,
      snippet: code.slice(0, 80) + (code.length > 80 ? '...' : ''),
      file: filePath ? path.basename(filePath) : 'Unknown',
    });
    if (usageData.history.length > 50) usageData.history = usageData.history.slice(0, 50);
    saveUsage(usageData);

    let result;
    try { result = JSON.parse(data.choices[0].message.content); }
    catch (e) { result = null; }

    // Guard: the model can return null, a bare value, or unparseable text.
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      result = { action: 'append', startLine: null, endLine: null, reason: 'Could not determine exact placement — appending to end of file.', confidence: 50 };
    }
    if (!result.action) result.action = 'append';

    result.code = code; // Always preserve original
    return { success: true, result, tokensUsed };

  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('snippet:apply-to-file', async (_, { filePath, result }) => {
  if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'File not found.' };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let newLines = [...lines];

    const { action, startLine, endLine, code } = result;
    const codeLines = code.split('\n');

    if (action === 'replace' && startLine && endLine) {
      newLines.splice(startLine - 1, endLine - startLine + 1, ...codeLines);
    } else if (action === 'insert_after' && startLine) {
      newLines.splice(startLine, 0, ...codeLines);
    } else if (action === 'insert_before' && startLine) {
      newLines.splice(startLine - 1, 0, ...codeLines);
    } else {
      newLines.push(...codeLines);
    }

    fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('file:read', (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return { content: fs.readFileSync(filePath, 'utf8'), name: path.basename(filePath) };
  } catch (e) { return null; }
});

// ─── App Boot ──────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createPopupWindow();
  createDashboardWindow();
  createTray();

  const hotkey = savedSettings.hotkey || 'CommandOrControl+Alt+B';
  globalShortcut.register(hotkey, togglePopup);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* keep alive in tray */ });
