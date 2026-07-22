/**
 * Codeply AI — Popup Renderer
 * Handles: clipboard sync, AI file detection, analyze, multi-file apply,
 * file history revert, animated apply.
 * AI engine is built in (Groq) — there is no model or API-key UI.
 */

let currentCode = '';
let currentKind = 'none';   // 'code' | 'instruction' | 'replace' | 'written' | 'none'
let currentFile = null;
let analysisResult = null;
let fileContent = null;
let manualLock = false;   // true while a target is pinned (auto-detect OR a real Browse pick)
let browsedLock = false;  // true ONLY via the "File" (Browse) button — persists across snippets
let projectInfo = { ready: false, root: null, framework: null };
let detectionBadge = null; // 'Auto detected' | 'Suggested' | 'Manual' — shown after detection
let writeMode = false;     // true while the typed "Write" box is active (clipboard sync paused)
let writeHistory = [];     // recent turns this session: [{instruction, filePath, timestamp}], oldest first
const WRITE_HISTORY_MAX = 8;

let previewEl;
let lineNumsEl;
let filePathDisplay;
let autoDot;
let statusIcon;
let statusAction;
let statusReason;
let confidenceBar;
let confidenceFill;
let runBtn;
let writeInputEl;

function requireCodeply() {
  if (!window.codeply) throw new Error('Codeply bridge unavailable');
  return window.codeply;
}

function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handler(e);
  });
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─── First-run popup tutorial (copy code → Analyze → Apply) ────────────────────
// Walks a brand-new user through the actual popup flow: copy AI-edited code
// from anywhere, watch it land in the preview, click Analyze, then click Apply.
// Gated on a persisted per-machine flag (like the dashboard's onboarding) so it
// only ever runs once, the first time this popup is used. Clicking ANYWHERE in
// the popup while a step is showing skips straight to the next step (as well as
// still doing whatever that click normally does, e.g. a real Analyze/Apply).
let popupTutorialActive = false;
let popupTutorialStep = 0; // 0 = "copy code", 1 = "click Analyze", 2 = "click Apply"
let _popupSpotlightStop = null;
let _popupTutorialClickHandler = null;

function startPopupSpotlight(target, titleHtml, bodyHtml) {
  const overlay = document.getElementById('popupSpotlight');
  if (!target || !overlay) return () => {};

  function render() {
    const r = target.getBoundingClientRect();
    const pad = 6;
    const x = r.left - pad, y = r.top - pad, w = r.width + pad * 2, h = r.height + pad * 2;
    const calloutWidth = 220;
    let calloutLeft = x + w / 2 - calloutWidth / 2;
    calloutLeft = Math.max(10, Math.min(calloutLeft, window.innerWidth - calloutWidth - 10));
    const showBelow = y < window.innerHeight / 2;
    const calloutTop = showBelow ? y + h + 12 : null;
    const calloutBottomAnchor = !showBelow ? (window.innerHeight - y + 12) : null;
    const calloutStyle = showBelow
      ? `left:${calloutLeft}px;top:${calloutTop}px`
      : `left:${calloutLeft}px;bottom:${calloutBottomAnchor}px`;
    overlay.innerHTML = `
      <div class="spot-mask" style="left:0;top:0;right:0;height:${Math.max(0, y)}px"></div>
      <div class="spot-mask" style="left:0;top:${y + h}px;right:0;bottom:0"></div>
      <div class="spot-mask" style="left:0;top:${y}px;width:${Math.max(0, x)}px;height:${h}px"></div>
      <div class="spot-mask" style="left:${x + w}px;top:${y}px;right:0;height:${h}px"></div>
      <div class="spot-ring" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>
      <div class="spot-callout" style="${calloutStyle}">
        <strong>${titleHtml}</strong>
        ${bodyHtml}
      </div>
    `;
  }

  render();
  overlay.style.display = 'block';
  window.addEventListener('resize', render);

  function stop() {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
    window.removeEventListener('resize', render);
    if (_popupSpotlightStop === stop) _popupSpotlightStop = null;
  }
  _popupSpotlightStop = stop;
  return stop;
}

// Lets a click ANYWHERE in the popup skip the current step forward, while still
// letting the click reach its real target (e.g. Analyze/Apply keep working).
function armPopupTutorialSkip() {
  disarmPopupTutorialSkip();
  _popupTutorialClickHandler = () => skipPopupTutorialStep();
  document.addEventListener('click', _popupTutorialClickHandler, { capture: true });
}

function disarmPopupTutorialSkip() {
  if (!_popupTutorialClickHandler) return;
  document.removeEventListener('click', _popupTutorialClickHandler, { capture: true });
  _popupTutorialClickHandler = null;
}

function skipPopupTutorialStep() {
  if (!popupTutorialActive) return;
  if (popupTutorialStep === 0) showPopupTutorialStep(1);
  else if (popupTutorialStep === 1) completePopupTutorial();
}

function showPopupTutorialStep(step) {
  popupTutorialStep = step;
  if (_popupSpotlightStop) _popupSpotlightStop();

  if (step === 0) {
    startPopupSpotlight(document.getElementById('previewWrap'), 'Type your request',
      `Describe what you want, or hit Paste to bring in code you copied. (Click anywhere to skip)`);
  } else if (step === 1) {
    startPopupSpotlight(document.getElementById('runBtn'), 'Click Apply',
      `Codeply figures out where this goes and applies it, all in one step.`);
  }
  armPopupTutorialSkip();
}

async function initPopupTutorial() {
  try {
    const settings = await requireCodeply().getSettings();
    if (settings.popupTutorialDone) return;
  } catch { return; }

  popupTutorialActive = true;
  showPopupTutorialStep(0);
}

function advancePopupTutorialAfterCopy() {
  if (!popupTutorialActive || popupTutorialStep !== 0) return;
  showPopupTutorialStep(1);
}

function completePopupTutorial() {
  if (!popupTutorialActive) return;
  popupTutorialActive = false;
  disarmPopupTutorialSkip();
  if (_popupSpotlightStop) _popupSpotlightStop();
  requireCodeply().saveSettings({ popupTutorialDone: true }).catch(() => {});
}

// ─── Toasts ────────────────────────────────────────────────────────────────────
function showToast(title, body, isError = false) {
  document.querySelectorAll('.cp-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'cp-toast' + (isError ? ' error' : '');
  toast.innerHTML = `<div class="cp-toast-title">${escHtml(title)}</div>` +
    (body ? `<div class="cp-toast-body">${escHtml(body)}</div>` : '');
  document.body.appendChild(toast);
  const kill = () => {
    if (!toast.isConnected) return;
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener('click', kill);
  setTimeout(kill, 4500);
}

// ─── Cache indicator (⚡ cached) ────────────────────────────────────────────────
function setCacheBadge(on) {
  const b = document.getElementById('cacheBadge');
  if (b) b.style.display = on ? '' : 'none';
}

// ─── Framework badge ───────────────────────────────────────────────────────────
async function refreshProjectInfo() {
  try {
    projectInfo = await requireCodeply().getProjectInfo() || projectInfo;
  } catch { }
  const badge = document.getElementById('fwBadge');
  if (badge) {
    if (projectInfo.framework) {
      badge.textContent = projectInfo.framework;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ─── Line diff (for the multi-file preview) ────────────────────────────────────
// Simple LCS-based line diff, capped for very large files.
function computeDiff(oldStr, newStr) {
  const a = (oldStr || '').replace(/\r\n/g, '\n').split('\n');
  const b = (newStr || '').replace(/\r\n/g, '\n').split('\n');
  if (a.length + b.length > 1600) return null;    // too big — caller shows fallback

  // LCS table (a.length+1 x b.length+1)
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];   // { type: 'ctx'|'del'|'add', text }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', text: a[i++] }); }
  while (j < m) { ops.push({ type: 'add', text: b[j++] }); }
  return ops;
}

// Render a diff as hunks with 2 context lines; collapse long unchanged runs.
function renderDiffHtml(oldStr, newStr) {
  const ops = computeDiff(oldStr, newStr);
  if (!ops) {
    return `<div class="diff-gap">File too large to diff, applying will use the merged version.</div>` +
      (newStr || '').split('\n').slice(0, 40).map(l => `<div class="diff-line add">+ ${escHtml(l)}</div>`).join('');
  }
  const CTX = 2;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'ctx') return;
    for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) keep[k] = true;
  });
  if (!keep.some(Boolean)) return `<div class="diff-gap">No changes, file already matches.</div>`;
  let html = '', skipping = 0;
  ops.forEach((op, idx) => {
    if (!keep[idx]) { skipping++; return; }
    if (skipping > 0) { html += `<div class="diff-gap">… ${skipping} unchanged line(s)</div>`; skipping = 0; }
    const sign = op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ';
    html += `<div class="diff-line ${op.type}">${sign} ${escHtml(op.text)}</div>`;
  });
  if (skipping > 0) html += `<div class="diff-gap">… ${skipping} unchanged line(s)</div>`;
  return html;
}

function confBadgeHtml(f) {
  if (f.isNew) return `<span class="conf-badge new">new file</span>`;
  return `<span class="conf-badge ${f.confidence}">${f.confidence}</span>`;
}

// ─── Lightweight language guess (renderer-side, mirrors main.js's detector) ───
// Only needs to catch the CLEAREST mismatches (CSS vs Python etc.) — good
// enough to decide "is this fallback file obviously wrong" without a round-trip.
function guessLanguage(code) {
  const t = code || '';
  if (/[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^{}]*[\w-]+\s*:\s*[^;{}]+;/.test(t)) return 'CSS';
  if (/\bdef\s+\w+\(.*\)\s*:/.test(t) || (/^\s*import\s+\w+/.test(t) && !/[{};]/.test(t))) return 'Python';
  if (/<\/?[a-zA-Z][^>]*>/.test(t)) return 'HTML';
  if (/\bconst\b|\blet\b|\bfunction\b|=>/.test(t)) return 'JavaScript';
  return null;
}

function looksForeignTo(code, filePath) {
  if (!filePath) return false;
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const lang = guessLanguage(code);
  if (lang === 'CSS') return !['css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte'].includes(ext);
  if (lang === 'Python') return ['js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'json'].includes(ext);
  return false;
}

// A sensible default path for a brand-new file, editable by the user before
// they confirm (the detect sheet's "New file path" input).
function suggestedNewFilePath(code) {
  switch (guessLanguage(code)) {
    case 'CSS': return 'styles.css';
    case 'Python': return 'new_module.py';
    case 'HTML': return 'new-page.html';
    case 'JavaScript': return 'new-script.js';
    default: return 'new-file.txt';
  }
}

function initPopupRenderer() {
  previewEl = document.getElementById('preview');
  lineNumsEl = document.getElementById('lineNumbers');
  filePathDisplay = document.getElementById('filePathDisplay');
  autoDot = document.getElementById('autoDot');
  statusIcon = document.getElementById('statusIcon');
  statusAction = document.getElementById('statusAction');
  statusReason = document.getElementById('statusReason');
  confidenceBar = document.getElementById('confidenceBar');
  confidenceFill = document.getElementById('confidenceFill');
  runBtn = document.getElementById('runBtn');
  writeInputEl = document.getElementById('writeInput');

  const codeply = requireCodeply();

  initPopupTutorial();

// The popup is typing-only now — clipboard content only ever enters through
// the write box's own Paste button, never automatically. Background
// clipboard-sync pushes from main are simply ignored.
codeply.onSnippetUpdate(() => {});

// ─── Active-file targeting ──────────────────────────────────────────────────────
// currentFile is only ever set once a target is genuinely CONFIRMED — by the
// user (Browse), by an explicit filename mentioned/hinted in the copied text,
// or by the AI/grep file-detection engine. The "most recently saved file in
// the watched folder" is never auto-promoted to a target on its own; it's
// tracked separately (lastEditedFile) purely as a last-resort fallback if
// detection genuinely can't find anything better.
let watchFolderPath = null;
let lastEditedFile = null;   // { path, name, lineCount } — background info only

async function setTargetFile(filePath, { manual = false } = {}) {
  currentFile = filePath;
  manualLock = manual;
  const fileData = filePath ? await requireCodeply().readFile(filePath) : null;
  fileContent = fileData ? fileData.content : null;
  renderFileBar();
  analysisResult = null;
}

// Reflects the current targeting state into the file-bar: a confirmed file
// name (green, "active"), or — far more often — just the watched FOLDER name,
// since no specific file should look targeted until one is actually confirmed.
function renderFileBar() {
  if (currentFile) {
    const name = currentFile.split(/[\\/]/).pop();
    const short = currentFile.length > 38 ? '…' + currentFile.slice(-36) : currentFile;
    filePathDisplay.textContent = manualLock ? short : name;
    filePathDisplay.classList.add('active');
    filePathDisplay.title = currentFile;
    autoDot.classList.toggle('live', !manualLock);
  } else if (watchFolderPath) {
    filePathDisplay.textContent = watchFolderPath.split(/[\\/]/).pop();
    filePathDisplay.classList.remove('active');
    filePathDisplay.title = watchFolderPath;
    autoDot.classList.add('live');
  } else {
    filePathDisplay.textContent = 'No folder watched, pick one to auto-detect files';
    filePathDisplay.classList.remove('active');
    autoDot.classList.remove('live');
  }
}

// Most-recently-edited file in the folder, pushed from main. Recorded as
// background context only — never shown as "the target" and never used
// unless detection has no better answer (see ensureTargetFileOrFallback).
codeply.onActiveFile((f) => {
  if (!f || !f.path) { lastEditedFile = null; if (!currentFile) renderFileBar(); return; }
  lastEditedFile = f;
  if (!manualLock && !currentFile) renderFileBar();   // still just watching — nothing to override
});

// Called right before Analyze acts on a snippet that didn't get a confirmed
// target from the code-detection flow (instructions, full-replace, or code
// detection that came back empty). Falls back to the last-edited file ONLY
// as an explicit, clearly-labeled last resort — never silently.
async function ensureTargetFileOrFallback() {
  if (currentFile) return true;
  if (lastEditedFile && lastEditedFile.path) {
    await setTargetFile(lastEditedFile.path, { manual: false });
    setStatus('idle', 'No explicit match', `Falling back to the last-edited file: ${lastEditedFile.name}. Use “File” to pick a different one.`);
    return true;
  }
  setStatus('error', 'No target file', 'Codeply couldn’t tell which file to use. Pick one with “File”, or copy a full-file replace.');
  return false;
}

// ─── Status Helper ─────────────────────────────────────────────────────────────
function setStatus(type, action, reason, confidence) {
  statusIcon.className = `status-icon ${type}`;
  statusIcon.textContent = { idle: '◈', analyzing: '◌', ready: '✓', error: '✕', applying: '▶' }[type] || '◈';
  statusAction.textContent = action;
  statusReason.textContent = reason;

  if (confidence !== undefined) {
    confidenceBar.style.display = 'block';
    confidenceFill.style.width = confidence + '%';
    confidenceFill.className = 'confidence-fill' +
      (confidence < 40 ? ' low' : confidence < 70 ? ' mid' : '');
  } else {
    confidenceBar.style.display = 'none';
  }
}

// ─── Manual file pick (locks auto-detect, persists across snippets) ───────────
bindClick('browseBtn', async () => {
  const filePath = await codeply.browseFile();
  if (!filePath) return;
  await setTargetFile(filePath, { manual: true });
  browsedLock = true;   // deliberate pick — unlike auto-detect, this sticks
  detectionBadge = 'Manual';
  const lc = fileContent ? fileContent.split('\n').length : '?';
  setStatus('idle', 'File locked', `${lc} lines, auto-detect paused. Hit Apply.`);
});

// ─── Watch folder (enables auto-detect) ─────────────────────────────────────────
bindClick('watchBtn', async () => {
  const folder = await codeply.pickWatchFolder();
  if (!folder) return;
  manualLock = false;
  browsedLock = false;
  currentFile = null;          // switching folders — drop any previous confirmed target
  lastEditedFile = null;
  writeHistory = [];           // new project, previous conversation no longer applies
  watchFolderPath = folder;
  renderFileBar();
  setStatus('idle', 'Folder watched', 'Copy code and hit Apply, Codeply finds the right file itself.');
  // .codeply/ store + framework detection just ran in main — refresh the badge.
  setTimeout(refreshProjectInfo, 400);
});

// ─── Write box — the popup's ONE input surface, typing-only ────────────────────
// Describe what you want ("in main.py make a flappy bird game with pygame",
// "change the button color to green") and Codeply runs it as an instruction,
// agent-style. Paste (via the button, or Ctrl+V) brings in copied code so you
// can pair it with a typed instruction in the same box. There is no toggle —
// this is the only mode; the old preview/line-numbers pane is repurposed to
// show the result (diff/highlight) briefly after Apply, then returns here.
function showWriteBox() {
  writeMode = true;
  writeInputEl.style.display = 'block';
  document.getElementById('pasteBtn').style.display = 'flex';
  previewEl.style.display = 'none';
  lineNumsEl.style.display = 'none';
  setTimeout(() => writeInputEl.focus(), 30);
}

function showResultView() {
  writeMode = false;
  writeInputEl.style.display = 'none';
  document.getElementById('pasteBtn').style.display = 'none';
  previewEl.style.display = '';
  lineNumsEl.style.display = '';
}

writeInputEl?.addEventListener('input', () => {
  currentCode = writeInputEl.value;
  currentKind = currentCode.trim() ? 'written' : 'none';
  runBtn.disabled = !currentCode.trim();
  if (currentCode.trim()) {
    setStatus('idle', 'Ready to apply', 'Hit Apply, Codeply will figure out what to do and apply it.');
    advancePopupTutorialAfterCopy();
  }
});

writeInputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!runBtn.disabled) runBtn.click();
  }
});

// One-click paste — pulls in whatever's on the clipboard (e.g. copied from
// ChatGPT/Claude in the browser) without leaving Write mode, so you can pair
// pasted code with a typed instruction in the same box.
bindClick('pasteBtn', async () => {
  let text = '';
  try { text = await codeply.readClipboard(); } catch { }
  if (!text) return;
  const el = writeInputEl;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.focus();
  const pos = start + text.length;
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input'));   // reuse the existing handler to sync currentCode/kind
});

// A capped-out day isn't really a "failure" — give it its own title.
function applyErrorTitle(msg) {
  return /daily apply limit/i.test(String(msg || '')) ? 'Daily limit reached' : 'Apply failed';
}

// ─── Friendly error messages ───────────────────────────────────────────────────
function friendlyError(raw) {
  const s = String(raw).toLowerCase();
  const detail = String(raw).slice(0, 120); // show up to 120 chars of raw error for debugging

  // ① Rate limit — distinguish a DAILY quota (hours, not moments, to reset)
  // from a short per-minute burst limit, since "wait a moment" is actively
  // misleading for the former.
  if (s.includes('tokens per day') || s.includes(' tpd') || s.includes('daily'))
    return { title: 'Daily limit reached', msg: 'The free AI quota for today is used up. It resets daily, try again later or upgrade at console.groq.com.' };
  if (s.includes('rate limit') || s.includes('ratelimit') || s.includes('too many request') || s.includes('429') || s.includes('tokens per minute') || s.includes(' tpm'))
    return { title: 'Rate limited', msg: 'Too many requests right now, wait a minute and try again.' };

  // ② AI engine unavailable (missing env key — details are in the app console only)
  if (s.includes('ai engine unavailable'))
    return { title: 'AI unavailable', msg: 'Smart placement is temporarily off, offline placement was used instead.' };

  // ③ Timeout
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout'))
    return { title: 'Request timed out', msg: 'The AI took too long, please try again.' };

  // ④ Token / context limit
  if (s.includes('max_tokens') || s.includes('context length') || s.includes('too long') || (s.includes('token') && s.includes('limit')))
    return { title: 'Code too long', msg: 'Snippet is too large for one request. Try a smaller selection.' };

  // ④b Structured-output hiccup — the model couldn't format valid JSON even
  // after retries. Usually transient; a re-run often just works.
  if (s.includes('failed to generate json') || s.includes('failed_generation') || s.includes('unreadable response') || s.includes('could not produce a valid response'))
    return { title: 'AI had trouble responding', msg: 'It couldn’t format a valid answer this time, even after retrying. Hit Apply again, or simplify the request.' };

  // ⑤ Server error
  if (s.includes('500') || s.includes('502') || s.includes('503') || s.includes('server error') || s.includes('internal error'))
    return { title: 'Server error', msg: `The AI service is having issues, try again shortly. (${detail})` };

  // ⑥ Network / connection
  if (s.includes('enotfound') || s.includes('econnrefused') || s.includes('econnreset') || s.includes('failed to fetch') || s.includes('fetch failed') || s.includes('networkerror') || s.includes('network error'))
    return { title: 'Connection failed', msg: `Could not reach the AI service. Check your internet connection. (${detail})` };

  // ⑦ Generic fallback
  return { title: 'Analysis failed', msg: detail || 'Something went wrong. Please try again.' };
}

// ─── Token Cap Enforcement ─────────────────────────────────────────────────────
let _tokenCap = 0;
function _fmtN(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
async function checkTokenCap() {
  if (!_tokenCap) return true;
  try {
    const u = await requireCodeply().getUsage();
    const used = u.totalTokens || 0;
    if (used >= _tokenCap) {
      setStatus('error', 'Token cap reached',
        `${_fmtN(used)} / ${_fmtN(_tokenCap)} tokens used.`);
      runBtn.disabled = true;
      return false;
    }
  } catch { /* fail open */ }
  return true;
}

// ─── Run (analyze + apply, one click) ───────────────────────────────────────────
bindClick('runBtn', async () => {
  if (!await checkTokenCap()) return;

  if (!currentCode || currentCode.trim().startsWith('//')) {
    setStatus('error', 'No code copied', 'Copy some AI-generated code first');
    return;
  }

  runBtn.textContent = 'Applying…';
  runBtn.disabled = true;
  setCacheBadge(false);

  // ── Typed request (Write box) — always run as an instruction, regardless
  // of phrasing, since the user explicitly wrote this with intent. Re-checks
  // for an explicit filename hint ("in style.css …") on EVERY run, ignoring
  // any file locked by a PREVIOUS write request — each typed request is its
  // own independent turn (like a chat message), so a stale lock from an
  // earlier request must never carry over and silently hijack a new one.
  // Only a real Browse pick (browsedLock) is deliberate enough to persist.
  if (currentKind === 'written') {
    if (!browsedLock && projectInfo.ready) {
      const hint = await codeply.hintFile(currentCode).catch(() => null);
      if (hint) {
        await setTargetFile(hint.absPath, { manual: false });
        detectionBadge = 'Mentioned by you';
      } else if (!currentFile || guessLanguage(currentCode)) {
        // No filename mentioned. Either nothing's targeted yet, or this
        // request actually carries real code (not just a bare follow-up
        // like "also make it responsive") — re-search every time real code
        // is present, since that's exactly when the right target can differ
        // between two files of the SAME type (two .css files, say), which a
        // coarse "wrong language" check alone can never tell apart. A pure
        // instruction with no code payload skips the search and just
        // continues on whatever's already targeted.
        setStatus('analyzing', 'Searching your project…', 'Matching this against your files…');
        statusIcon.innerHTML = '<span class="spin-icon">◌</span>';
        let det = null;
        try { det = await codeply.detectFiles(currentCode); } catch { }
        if (det && det.success && Array.isArray(det.files) && det.files.length) {
          const top = det.files[0];
          if (top.confidence === 'high' && !top.isNew) {
            await setTargetFile(top.absPath, { manual: false });
            detectionBadge = 'Auto detected';
          } else {
            // Medium/low/new — never silently trust either a guess or a
            // possibly-stale existing target; let the user confirm.
            resetRunBtn();
            openDetectSheet(det);
            return;
          }
        } else if (!currentFile) {
          // Nothing matched anywhere and nothing's targeted — propose
          // creating the right file instead of a dead end.
          resetRunBtn();
          openDetectSheet({
            success: true, framework: projectInfo.framework, multiFile: false,
            files: [{
              path: suggestedNewFilePath(currentCode), confidence: 'low', isNew: true, snippetPart: null,
              reason: 'No existing file matched this. Create a new one, or pick one manually.',
            }],
          });
          return;
        }
        // else: genuinely nothing matched, but a target already exists —
        // keep it, there's no better signal to act on.
      }
      // else: no hint, no code payload (a plain follow-up instruction) —
      // keep the existing target, the right default for "also do X".
    }
    if (!await ensureTargetFileOrFallback()) { resetRunBtn(); return; }
    await runClassicAnalyze({ forceInstruction: true, history: writeHistory });
    return;
  }

  // ── Task 4: AI file detection — figure out WHERE the code goes first.
  // Skipped when the user hand-picked a file (manual lock) or for
  // instructions/full-replace, which act on the current target.
  if (currentKind === 'code' && !manualLock && projectInfo.ready) {
    setStatus('analyzing', 'Detecting target file…', 'Matching this code against your project structure…');
    statusIcon.innerHTML = '<span class="spin-icon">◌</span>';
    let det = null;
    try { det = await codeply.detectFiles(currentCode); } catch { }
    if (det && det.success && Array.isArray(det.files) && det.files.length) {
      if (det.cached) setCacheBadge(true);

      // Multiple files' worth of code → multi-file preview flow.
      const parts = det.files.filter(f => f.snippetPart);
      if (parts.length > 1) {
        resetRunBtn();
        openMultiSheet(parts, det.framework);
        return;
      }

      const top = det.files[0];
      if (top.confidence === 'high' && !top.isNew) {
        // High confidence — silently target the detected file and continue.
        await setTargetFile(top.absPath, { manual: false });
        detectionBadge = det.hinted ? 'Mentioned by you' : 'Auto detected';
        manualLock = true;   // hold this target until the next copy/pick
      } else {
        // Medium/low/new — let the user confirm via the detection sheet.
        resetRunBtn();
        openDetectSheet(det);
        return;
      }
    }
    // Detection unavailable, ambiguous, or offline — no confirmed target yet.
    const noCandidates = !det || !det.success || !Array.isArray(det.files) || !det.files.length;
    if (noCandidates) {
      const fallbackPath = lastEditedFile && lastEditedFile.path;
      const foreign = fallbackPath && looksForeignTo(currentCode, fallbackPath);
      if (!fallbackPath || foreign) {
        // Nothing safe to fall back to — a coding-agent harness proposes
        // creating the right file here instead of guessing wrong and
        // corrupting an unrelated one. Reuse the same detect sheet UI.
        resetRunBtn();
        openDetectSheet({
          success: true, framework: projectInfo.framework, multiFile: false,
          files: [{
            path: suggestedNewFilePath(currentCode), confidence: 'low', isNew: true, snippetPart: null,
            reason: foreign
              ? `This looks like ${guessLanguage(currentCode)}, but ${fallbackPath.split(/[\\/]/).pop()} doesn't match. Create a new file, or pick one manually.`
              : 'No existing file matched this code. Create a new one, or pick one manually.',
          }],
        });
        return;
      }
      // Fallback is at least plausible for this snippet's language — proceed.
    }
  }

  if (!await ensureTargetFileOrFallback()) { resetRunBtn(); return; }

  await runClassicAnalyze();
});

function resetRunBtn() {
  runBtn.textContent = 'Apply';
  runBtn.disabled = false;
}

// Analyzes the request, then — since Run is one click now — goes straight
// into applying it. No separate confirmation step for the direct path.
async function runClassicAnalyze(opts = {}) {
  runBtn.textContent = 'Applying…';
  runBtn.disabled = true;

  // Pulse the status icon
  statusIcon.innerHTML = '<span class="spin-icon">◌</span>';
  setStatus('analyzing', opts.forceInstruction ? 'AI working on your request…' : 'AI analyzing placement…', currentFile
    ? `Scanning ${currentFile.split('/').pop() || currentFile.split('\\').pop()}…`
    : 'No file loaded, will suggest placement type');

  const result = await codeply.analyzeSnippet({
    code: currentCode,
    filePath: currentFile,
    forceInstruction: !!opts.forceInstruction,
    history: opts.history || [],
  });

  if (!result.success) {
    resetRunBtn();
    const { title, msg } = friendlyError(result.error || '');
    setStatus('error', title, msg);
    const mb = document.getElementById('modelBadge'); if (mb) mb.style.display = 'none';
    return;
  }

  // ⚡ cached indicator (Task 3) + engine/detection badges
  setCacheBadge(!!result.cached);
  const mb = document.getElementById('modelBadge');
  if (mb) {
    const bits = [];
    if (detectionBadge) bits.push(detectionBadge);
    if (result.modelUsed && !result.cached) bits.push(`via ${result.modelUsed}`);
    mb.textContent = bits.join(' · ');
    mb.style.display = bits.length ? 'block' : 'none';
  }

  analysisResult = result.result;
  const r = analysisResult;

  // Detect a REAL AI failure that leaked into a "successful" offline result.
  // NB: don't match bare "offline" — the normal local-placement fallback reason
  // legitimately says "used offline placement", which is NOT an error.
  const reasonHasError = r.reason && /all models failed|fetch failed|failed to fetch|credits|no endpoint|invalid model|afford|max_token|rate limit|unauthorized|forbidden|api key|invalid key|server error|timed out|enotfound|econnrefused|econnreset|http [45]\d\d/i.test(r.reason);
  if (reasonHasError) {
    resetRunBtn();
    const { title, msg } = friendlyError(r.reason);
    setStatus('error', title, msg);
    return;
  }

  if (r.action === 'none') {
    resetRunBtn();
    setStatus('error', 'No change', r.reason, r.confidence);
    return;
  }

  await performApply(r);
}

// ─── Detection sheet (suggested / pick / new file) ─────────────────────────────
let detectState = { files: [], selected: -1 };

function openDetectSheet(det) {
  const sheet = document.getElementById('detectSheet');
  const list = document.getElementById('detectList');
  const hint = document.getElementById('detectHint');
  const fw = document.getElementById('detectFwBadge');
  const newWrap = document.getElementById('newFileWrap');
  const cont = document.getElementById('detectContinueBtn');

  detectState = { files: det.files.slice(0, 3), selected: -1 };

  if (fw) {
    if (det.framework) { fw.textContent = det.framework; fw.style.display = ''; }
    else fw.style.display = 'none';
  }

  const top = detectState.files[0];
  const title = document.getElementById('detectTitle');
  if (top.isNew) {
    title.textContent = 'New file suggested';
    hint.textContent = 'This code looks like it belongs in a file that doesn\'t exist yet. Create it, or pick an existing file.';
  } else if (top.confidence === 'medium') {
    title.textContent = 'Confirm the target file';
    hint.textContent = 'Codeply is fairly sure this is the right file, confirm or pick another.';
  } else {
    title.textContent = 'Pick the target file';
    hint.textContent = 'Codeply isn\'t certain. Here are the best matches, ranked.';
  }

  list.innerHTML = detectState.files.map((f, i) => `
    <div class="cand" data-i="${i}">
      <div class="cand-radio"></div>
      <div class="cand-info">
        <div class="cand-path">${escHtml(f.path)}</div>
        <div class="cand-reason">${escHtml(f.reason || '')}</div>
      </div>
      ${confBadgeHtml(f)}
    </div>
  `).join('');

  const select = (i) => {
    detectState.selected = i;
    list.querySelectorAll('.cand').forEach((el, k) => el.classList.toggle('selected', k === i));
    const f = detectState.files[i];
    if (f && f.isNew) {
      newWrap.style.display = '';
      document.getElementById('newFilePath').value = f.path;
      cont.textContent = 'Create file & apply';
    } else {
      newWrap.style.display = 'none';
      cont.textContent = 'Use selected file';
    }
    cont.disabled = i < 0;
  };

  list.querySelectorAll('.cand').forEach(el => {
    el.addEventListener('click', () => select(parseInt(el.dataset.i, 10)));
  });

  // Medium-confidence: pre-highlight the suggestion so one click confirms it.
  select(top.confidence === 'medium' || top.isNew ? 0 : -1);

  sheet.classList.add('show');
}

function closeDetectSheet() { document.getElementById('detectSheet').classList.remove('show'); }

bindClick('detectClose', closeDetectSheet);

bindClick('detectManualBtn', async () => {
  const filePath = await codeply.browseFile();
  if (!filePath) return;
  closeDetectSheet();
  await setTargetFile(filePath, { manual: true });
  detectionBadge = 'Manual';
  await runClassicAnalyze();
});

bindClick('detectContinueBtn', async () => {
  const f = detectState.files[detectState.selected];
  if (!f) return;

  if (f.isNew) {
    // New-file flow: create it with the snippet as content, path user-editable.
    const relPath = (document.getElementById('newFilePath').value || f.path).trim();
    if (!relPath) return;
    closeDetectSheet();
    setStatus('applying', 'Creating file…', relPath);
    const merge = await codeply.smartMerge({ filePath: null, code: f.snippetPart || currentCode });
    const content = (merge && merge.success) ? merge.merged : (f.snippetPart || currentCode);
    const res = await codeply.applyMultiFiles([{ path: relPath, content }]);
    if (res && res.success) {
      setStatus('ready', 'File created', relPath, 95);
      showToast('✓ Created ' + relPath, 'The copied code was placed in the new file.');
    } else {
      const err = res?.results?.[0]?.error || res?.error || 'Could not create the file.';
      const title = /daily apply limit/i.test(err) ? 'Daily limit reached' : 'Create failed';
      setStatus('error', title, err);
      showToast(title, err, true);
    }
    return;
  }

  closeDetectSheet();
  await setTargetFile(f.absPath, { manual: false });
  manualLock = true;   // hold the confirmed target until the next copy
  detectionBadge = f.confidence === 'medium' ? 'Suggested' : 'Manual';
  await runClassicAnalyze();
});

// ─── Multi-file sheet (diff preview + toggles + one-click apply) ───────────────
let multiState = { items: [] };   // { file, merged, original, skipped, conflict, ready }

function openMultiSheet(parts, framework) {
  const sheet = document.getElementById('multiSheet');
  const list = document.getElementById('multiList');
  const fw = document.getElementById('multiFwBadge');
  if (fw) {
    if (framework) { fw.textContent = framework; fw.style.display = ''; }
    else fw.style.display = 'none';
  }

  multiState = { items: parts.map(f => ({ file: f, merged: null, original: '', skipped: false, conflict: false, ready: false })) };

  list.innerHTML = multiState.items.map((it, i) => `
    <div class="mf-card" data-i="${i}">
      <div class="mf-head">
        <div class="mf-check">✓</div>
        <div class="mf-path">${escHtml(it.file.path)}</div>
        ${confBadgeHtml(it.file)}
      </div>
      <div class="mf-conflict-note" style="display:none"></div>
      <div class="diff"><div class="diff-gap">Preparing merge…</div></div>
    </div>
  `).join('');

  list.querySelectorAll('.mf-head').forEach(head => {
    head.addEventListener('click', () => {
      const card = head.closest('.mf-card');
      const i = parseInt(card.dataset.i, 10);
      multiState.items[i].skipped = !multiState.items[i].skipped;
      card.classList.toggle('skipped', multiState.items[i].skipped);
      updateMultiApplyBtn();
    });
  });

  sheet.classList.add('show');
  updateMultiApplyBtn();

  // Merge each file sequentially (keeps request volume + UI updates sane).
  (async () => {
    for (let i = 0; i < multiState.items.length; i++) {
      const it = multiState.items[i];
      const card = list.querySelector(`.mf-card[data-i="${i}"]`);
      const diffEl = card.querySelector('.diff');
      try {
        const res = await codeply.smartMerge({
          filePath: it.file.isNew ? null : it.file.absPath,
          code: it.file.snippetPart || currentCode
        });
        if (res && res.success) {
          it.merged = res.merged;
          it.original = res.original || '';
          it.conflict = !!res.conflict;
          it.ready = true;
          if (res.cached) setCacheBadge(true);
          diffEl.innerHTML = renderDiffHtml(it.original, it.merged);
          if (it.conflict) {
            card.classList.add('conflict');
            const note = card.querySelector('.mf-conflict-note');
            note.style.display = '';
            note.textContent = '⚠ Possible merge conflict: ' + (res.reason || 'review this diff carefully before applying.');
          }
        } else {
          it.skipped = true;
          card.classList.add('skipped');
          diffEl.innerHTML = `<div class="diff-gap">Merge failed: ${escHtml(res?.error || 'unknown error')}</div>`;
        }
      } catch (e) {
        it.skipped = true;
        card.classList.add('skipped');
        diffEl.innerHTML = `<div class="diff-gap">Merge failed: ${escHtml(e.message)}</div>`;
      }
      updateMultiApplyBtn();
    }
  })();
}

function updateMultiApplyBtn() {
  const btn = document.getElementById('multiApplyBtn');
  const active = multiState.items.filter(it => !it.skipped);
  const ready = active.filter(it => it.ready);
  btn.textContent = active.length ? `Apply ${active.length} file${active.length > 1 ? 's' : ''}` : 'Nothing selected';
  btn.disabled = !active.length || ready.length < active.length;
}

function closeMultiSheet() { document.getElementById('multiSheet').classList.remove('show'); }

bindClick('multiClose', closeMultiSheet);
bindClick('multiCancelBtn', closeMultiSheet);

bindClick('multiApplyBtn', async () => {
  const chosen = multiState.items.filter(it => !it.skipped && it.ready && typeof it.merged === 'string');
  if (!chosen.length) return;
  const btn = document.getElementById('multiApplyBtn');
  btn.disabled = true; btn.textContent = 'Applying…';

  const res = await codeply.applyMultiFiles(chosen.map(it => ({
    path: it.file.absPath || it.file.path,
    content: it.merged,
    isNew: it.file.isNew
  })));

  closeMultiSheet();
  if (res && res.success) {
    const ok = (res.results || []).filter(r => r.success).map(r => r.path);
    const failed = (res.results || []).filter(r => !r.success);
    setStatus('ready', `Applied ${ok.length} file${ok.length > 1 ? 's' : ''}`, ok.join(', '), 100);
    showToast(`✓ Applied ${ok.length} file${ok.length > 1 ? 's' : ''}`, ok.join('\n'));
    if (failed.length) showToast(`${failed.length} file(s) failed`, failed.map(f => `${f.path}: ${f.error}`).join('\n'), true);
    // Refresh the preview if the current target was among them
    if (currentFile) {
      const updated = await codeply.readFile(currentFile);
      if (updated) { fileContent = updated.content; }
    }
  } else {
    setStatus('error', applyErrorTitle(res?.error), res?.error || 'No files were written.');
    showToast(applyErrorTitle(res?.error), res?.error || '', true);
  }
});

// ─── File-history sheet (Task 3 revert UI) ─────────────────────────────────────
function fmtWhen(ts) {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleString();
}

async function openHistorySheet() {
  const sheet = document.getElementById('historySheet');
  const list = document.getElementById('historyList');
  const label = document.getElementById('historyFileLabel');

  if (!currentFile) {
    label.textContent = 'No target file selected.';
    list.innerHTML = '<div class="diff-gap" style="border-radius:8px">Target a file first, then check its history here.</div>';
    sheet.classList.add('show');
    return;
  }

  label.textContent = currentFile;
  list.innerHTML = '<div class="diff-gap" style="border-radius:8px">Loading…</div>';
  sheet.classList.add('show');

  const snaps = await codeply.fileHistory.list(currentFile).catch(() => []);
  if (!snaps || !snaps.length) {
    list.innerHTML = '<div class="diff-gap" style="border-radius:8px">No saved versions yet. Codeply snapshots a file every time the AI changes it.</div>';
    return;
  }

  list.innerHTML = snaps.map(s => `
    <div class="hist-row" data-name="${escHtml(s.name)}">
      <div class="hist-info">
        <div class="hist-when">${escHtml(fmtWhen(s.timestamp))}</div>
        <div class="hist-meta">${new Date(s.timestamp).toLocaleString()} · ${(s.size / 1024).toFixed(1)} KB</div>
      </div>
      <button class="hist-revert">Revert</button>
    </div>
  `).join('');

  list.querySelectorAll('.hist-row').forEach(row => {
    row.querySelector('.hist-revert').addEventListener('click', async () => {
      const btn = row.querySelector('.hist-revert');
      btn.disabled = true; btn.textContent = 'Reverting…';
      const res = await codeply.fileHistory.revert(currentFile, row.dataset.name);
      if (res && res.success) {
        document.getElementById('historySheet').classList.remove('show');
        const updated = await codeply.readFile(currentFile);
        if (updated) { fileContent = updated.content; renderFileWithHighlight(fileContent, null, null); }
        const fname = currentFile.split(/[\\/]/).pop();
        setStatus('ready', 'Reverted', `${fname} restored to the selected version.`, 100);
        showToast('✓ Reverted ' + fname, 'The previous version was restored. The replaced version was snapshotted too.');
      } else {
        btn.disabled = false; btn.textContent = 'Revert';
        showToast('Revert failed', res?.error || '', true);
      }
    });
  });
}

bindClick('historyBtn', openHistorySheet);
bindClick('historyClose', () => document.getElementById('historySheet').classList.remove('show'));

// ─── Render file with highlight ────────────────────────────────────────────────
function renderFileWithHighlight(content, startLine, endLine) {
  const lines = content.split('\n');
  previewEl.textContent = content;

  lineNumsEl.innerHTML = lines.map((_, i) => {
    const ln = i + 1;
    const isTarget = startLine && endLine
      ? ln >= startLine && ln <= endLine
      : ln === startLine;
    return `<div class="line-num${isTarget ? ' highlight' : ''}" id="ln${ln}">${ln}</div>`;
  }).join('');

  // Scroll to target line
  if (startLine) {
    const lineHeight = 24; // 1.5rem at 16px
    previewEl.scrollTop = Math.max(0, (startLine - 3) * lineHeight);
  }
}

// ─── Apply with Animation ──────────────────────────────────────────────────────
// Applies a computed result immediately — the second half of what used to be
// a separate Apply click, now folded into Run so one click does both.
async function performApply(r) {
  completePopupTutorial();

  if (r.action === 'none') { resetRunBtn(); return; }

  // ── Delete / whole-file rewrite: apply then refresh the result view ──
  if (r.action === 'delete' || r.action === 'rewrite') {
    runBtn.textContent = 'Applying…';
    runBtn.disabled = true;
    setStatus('applying', 'Applying changes…', 'Writing to file…');

    const res = await codeply.applyToFile({ filePath: currentFile, result: r });
    if (!res.success) {
      setStatus('error', applyErrorTitle(res.error), res.error);
      resetRunBtn();
      return;
    }
    const updated = await codeply.readFile(currentFile);
    fileContent = updated ? updated.content : fileContent;
    showResultView();
    renderFileWithHighlight(fileContent, null, null);

    finishApply();
    return;
  }

  if (!currentFile) {
    // No file — just animate the paste in the preview
    await animateCodeInPreview(r.code, null, null);
    setStatus('ready', 'Done!', 'No file selected, showing preview animation only');
    resetRunBtn();
    return;
  }

  runBtn.textContent = 'Applying…';
  runBtn.disabled = true;
  setStatus('applying', 'Applying changes…', 'Writing to file…');

  // 1. Show red overlay on old code in the result view
  showResultView();
  if (fileContent) {
    await animateRedOverlay(r.startLine, r.endLine);
  }

  // 2. Apply to file
  const result = await codeply.applyToFile({ filePath: currentFile, result: r });

  if (!result.success) {
    setStatus('error', applyErrorTitle(result.error), result.error);
    resetRunBtn();
    return;
  }

  // 3. Read updated file
  const updated = await codeply.readFile(currentFile);
  fileContent = updated ? updated.content : fileContent;

  // 4. Typewriter animation of new code
  await animateCodeInPreview(r.code, r.startLine, r.endLine);

  finishApply();
}

// Shared success tail: confirm, remember the turn for context, then return
// to a fresh write box after a moment.
function finishApply() {
  const fname = currentFile.split('/').pop() || currentFile.split('\\').pop();
  setStatus('ready', 'Applied!', `Changes written to ${fname}`, 100);
  showToast('✓ Applied to ' + fname, currentFile);
  resetRunBtn();
  analysisResult = null;

  // Remember this turn so a follow-up ("make it 4 instead of 2", "also do
  // X") has real context to resolve against, not just the current file.
  if (currentKind === 'written' && currentCode.trim()) {
    writeHistory.push({ instruction: currentCode.trim(), filePath: currentFile, timestamp: Date.now() });
    if (writeHistory.length > WRITE_HISTORY_MAX) writeHistory = writeHistory.slice(-WRITE_HISTORY_MAX);
  }

  // Show the result briefly, then return to a fresh write box for the next request.
  setTimeout(() => { writeInputEl.value = ''; showWriteBox(); }, 3000);
}

// ─── Red overlay animation ─────────────────────────────────────────────────────
async function animateRedOverlay(startLine, endLine) {
  return new Promise(resolve => {
    if (!startLine) { resolve(); return; }
    const lineHeight = 24;
    const start = startLine || 1;
    const end = endLine || startLine;
    const top = (start - 1) * lineHeight;
    const height = (end - start + 1) * lineHeight;

    const overlay = document.createElement('div');
    overlay.className = 'code-line-overlay overlay-red';
    overlay.style.cssText = `top:${top + 12}px; height:${height}px; opacity:0; transition: opacity 0.2s;`;
    document.getElementById('previewWrap').appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.remove(); resolve(); }, 300);
      }, 600);
    });
  });
}

// ─── Typewriter paste animation ────────────────────────────────────────────────
async function animateCodeInPreview(code, startLine, endLine) {
  return new Promise(resolve => {
    const lineHeight = 24;

    // Show the new code replacing old lines via typewriter
    const lines = code.split('\n');
    const baseContent = fileContent || '';
    const baseLines = baseContent.split('\n');

    // Build the final content lines around insertion
    let beforeLines = [];
    let afterLines = [];

    if (startLine && endLine && baseLines.length) {
      beforeLines = baseLines.slice(0, startLine - 1);
      afterLines = baseLines.slice(endLine);
    } else if (startLine && baseLines.length) {
      beforeLines = baseLines.slice(0, startLine);
      afterLines = baseLines.slice(startLine);
    } else {
      beforeLines = baseLines;
    }

    const allLines = [...beforeLines, ...lines, ...afterLines];
    const insertStart = beforeLines.length + 1;
    const insertEnd = beforeLines.length + lines.length;

    // Render base content instantly
    previewEl.textContent = allLines.join('\n');
    lineNumsEl.innerHTML = allLines.map((_, i) => {
      const ln = i + 1;
      const isNew = ln >= insertStart && ln <= insertEnd;
      return `<div class="line-num${isNew ? ' highlight' : ''}" id="ln${ln}">${ln}</div>`;
    }).join('');

    // Green overlay on new lines
    const top = (insertStart - 1) * lineHeight;
    const height = lines.length * lineHeight;

    const greenOverlay = document.createElement('div');
    greenOverlay.className = 'code-line-overlay overlay-green';
    greenOverlay.style.cssText = `top:${top + 12}px; height:${height}px; opacity:0; transition: opacity 0.3s;`;
    document.getElementById('previewWrap').appendChild(greenOverlay);

    // Typewriter: replace just the new-code section
    // Re-render with typing effect
    const beforeText = beforeLines.join('\n') + (beforeLines.length ? '\n' : '');
    const afterText = (afterLines.length ? '\n' : '') + afterLines.join('\n');
    const fullCode = code;
    let charIndex = 0;
    const totalChars = fullCode.length;
    const charsPerFrame = Math.max(1, Math.ceil(totalChars / 40)); // ~40 frames

    previewEl.textContent = beforeText;
    requestAnimationFrame(() => { greenOverlay.style.opacity = '1'; });

    // Scroll to the new lines
    if (startLine) previewEl.scrollTop = Math.max(0, (insertStart - 3) * lineHeight);

    function typeNext() {
      charIndex += charsPerFrame;
      const typed = fullCode.slice(0, charIndex);
      previewEl.textContent = beforeText + typed + (charIndex < totalChars ? '|' : '') + afterText;

      if (charIndex < totalChars) {
        requestAnimationFrame(typeNext);
      } else {
        previewEl.textContent = beforeText + fullCode + afterText;
        // Fade out green overlay after 1.5s
        setTimeout(() => {
          greenOverlay.style.opacity = '0';
          setTimeout(() => { greenOverlay.remove(); resolve(); }, 400);
        }, 1500);
      }
    }

    setTimeout(() => requestAnimationFrame(typeNext), 200);
  });
}

// ─── Header Controls ───────────────────────────────────────────────────────────
bindClick('dismissBtn', () => codeply.dismiss());
bindClick('minimizeBtn', () => codeply.minimize());
bindClick('dashBtn', () => codeply.openDashboard());

// ─── Paywall ───────────────────────────────────────────────────────────────────
async function checkSubscriptionAndBlock() {
  try {
    const sub = await codeply.subscription.check();
    if (!sub.allowed) {
      const overlay = document.getElementById('popupPaywall');
      const icon    = document.getElementById('popupPaywallIcon');
      const title   = document.getElementById('popupPaywallTitle');
      const sub_el  = document.getElementById('popupPaywallSub');
      icon.textContent  = sub.reason === 'kill_switch' ? '🔒' : '🔒';
      title.textContent = sub.reason === 'kill_switch' ? 'Subscription Required' : 'Subscription Required';
      sub_el.textContent = sub.message || 'Subscribe to continue using Codeply.';
      overlay.classList.add('show');
      // Disable main controls
      runBtn.disabled = true;
    }
  } catch { /* fail-open */ }
}

bindClick('popupPaywallBtn', () => codeply.openDashboard());

  // ─── Init ──────────────────────────────────────────────────────────────────────
  (async () => {
    try {
      const settings = await codeply.getSettings();
      if (settings) {
        _tokenCap = parseInt(settings.tokenCap || 0, 10) || 0;
      }
    } catch (e) { console.error(e); }

    // Run cap check on startup so runBtn is blocked immediately if over cap
    await checkTokenCap();
    // Framework badge + project readiness for the detection flow
    await refreshProjectInfo();

    codeply.onSettingsUpdated?.(async (s) => {
      try {
        if (s) _tokenCap = parseInt(s.tokenCap || 0, 10) || 0;
        await checkTokenCap();
        await refreshProjectInfo();
      } catch (e) { console.error('[Codeply popup] settings hot-reload failed:', e); }
    });

    try {
      const w = await codeply.getWatch();
      if (w && w.folder) {
        watchFolderPath = w.folder;
        if (w.activeFile) {
          lastEditedFile = { path: w.activeFile, name: w.activeFile.split(/[\\/]/).pop() };
        }
        renderFileBar();   // shows the watched folder name, not a specific file
      }
    } catch (e) { console.error(e); }

    showWriteBox();
    setStatus('idle', 'Write your request', 'Describe what you want, or hit Paste to bring in copied code, then hit Apply (or press Enter).');
    checkSubscriptionAndBlock();
    initPopupUpdater();
  })();
}

// ─── In-app update overlay (popup) ──────────────────────────────────────────────
function initPopupUpdater() {
  const up = window.codeply && window.codeply.updater;
  if (!up) return;
  const $ = (id) => document.getElementById(id);
  const overlay = $('popupUpdate');
  if (!overlay) return;

  const show = (stage) => {
    overlay.style.display = 'flex';
    const prog = $('puProgressWrap'), install = $('puInstallBtn'), restart = $('puRestartBtn');
    const title = $('puTitle'), sub = $('puSub');
    prog.style.display = 'none'; install.style.display = 'none'; restart.style.display = 'none';
    if (stage === 'available') {
      title.textContent = 'Update Required';
      sub.textContent = 'A new version of Codeply is available. Install it to keep going.';
      install.style.display = 'block';
    } else if (stage === 'downloading') {
      title.textContent = 'Installing Update';
      sub.textContent = 'Downloading the latest version, please keep Codeply open.';
      prog.style.display = 'block';
    } else if (stage === 'downloaded') {
      title.textContent = 'Update Ready';
      sub.textContent = 'Restart Codeply to finish installing the new version.';
      restart.style.display = 'block';
    }
  };

  up.onAvailable?.(() => show('available'));
  up.onProgress?.((p) => {
    show('downloading');
    const pct = Math.max(0, Math.min(100, p.percent || 0));
    $('puBar').style.width = pct + '%';
    $('puPct').textContent = pct + '%';
  });
  up.onDownloaded?.(() => show('downloaded'));

  bindClick('puInstallBtn', async () => { show('downloading'); try { await up.download(); } catch {} });
  bindClick('puRestartBtn', async () => {
    const b = $('puRestartBtn'); b.textContent = 'Restarting…'; b.disabled = true;
    try { await up.install(); } catch {}
  });
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    initPopupRenderer();
  } catch (e) {
    console.error('[Codeply popup] init failed:', e);
  }
});
