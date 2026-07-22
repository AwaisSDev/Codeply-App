/**
 * Codeply — "alive" startup notification (Task 2)
 *
 * A tiny frameless window that slides in from the right edge of the screen
 * and tells the user Codeply is running and how to summon it. It stays on
 * screen until the user closes it (subtle ✕), and offers a one-click
 * "don't show this again" opt-out (persisted via settings). Never steals
 * focus, never blocks interaction with other apps, skips the taskbar.
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIN_W = 356;
const WIN_H = 128;

let aliveWindow = null;

/**
 * Show the notification. Safe to call repeatedly (startup + re-foreground):
 * if one is already on screen it is left alone. Callers are expected to skip
 * the call entirely when the user opted out (settings.aliveNotificationDisabled).
 * @param {string} uiRoot directory containing Renderer/ (supports OTA UI root)
 */
function showAliveNotification(uiRoot) {
  if (aliveWindow && !aliveWindow.isDestroyed()) return;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  aliveWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: width - WIN_W,                 // hugs the right edge
    y: Math.max(0, height - WIN_H - 28),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,                 // never steals focus from the user's app
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      // The standard bridge gives the page saveSettings() for the opt-out.
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  aliveWindow.setAlwaysOnTop(true, 'screen-saver');
  aliveWindow.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });

  // OS-aware shortcut label: Cmd on macOS, Ctrl everywhere else.
  const shortcut = process.platform === 'darwin' ? 'Cmd + C' : 'Ctrl + C';
  const file = path.join(uiRoot, 'Renderer', 'alive.html');
  aliveWindow.loadFile(file, { query: { shortcut } });

  aliveWindow.once('ready-to-show', () => {
    if (!aliveWindow || aliveWindow.isDestroyed()) return;
    aliveWindow.showInactive();       // visible without taking focus
  });

  aliveWindow.on('closed', () => { aliveWindow = null; });
}

module.exports = { showAliveNotification };
