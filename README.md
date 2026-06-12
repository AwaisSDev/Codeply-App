# Codeply AI — Setup

## Structure
```
codeply/
├── main.js              ← Electron main process
├── preload.js           ← IPC bridge
├── package.json
├── Favicon.png          ← App icon (copy yours here)
├── renderer/
│   ├── index.html       ← Overlay popup UI
│   └── renderer.js      ← Popup logic
└── dashboard/
    ├── index.html       ← Dashboard app
    └── dashboard.js     ← Dashboard logic
```

## Install & Run
```bash
npm install
npm start
```

## How It Works

1. **Copy** AI-generated code from ChatGPT/Claude anywhere
2. **Hit** `Alt+C` → overlay appears top-right
3. **Codeply auto-detects** the file you're editing by reading the focused IDE's window title — shown as a read-only pill (● auth.py). No browsing, no file picker.
4. **Hit Analyze** → AI finds exact line placement (preserves your code unchanged)
5. **Hit Apply** → red overlay fades old lines, typewriter pastes new code with green highlight
6. Changes are **written to disk** automatically

## API Keys
- **OpenRouter**: Get key at openrouter.ai (supports GPT-4o, Claude, etc.)
- **Groq**: Get key at console.groq.com (free, fast Llama)

Enter your key in the overlay settings (green dot) or Dashboard → Settings.

## Notes
- The AI **never modifies your code** — it only finds where to put it
- The active file is **auto-detected** from your editor's window title (VS Code, Cursor, JetBrains, Vim, …) every time the overlay opens — you never pick a file manually
- Dashboard opens on launch; close it to minimize to system tray
- Hotkey works system-wide even when Codeply is in background
