/**
 * Codeply AI — Popup Renderer
 * Handles: clipboard sync, file selection, AI analyze, animated apply
 */

let currentCode = '';
let currentFile = null;
let analysisResult = null;
let fileContent = null;
let manualLock = false;   // true when user hand-picks a file (pauses auto-detect override)

let _models = [];          // [{id, modelId, provider, enabled}]
let selectedModelId = null; // currently chosen model id

let previewEl;
let lineNumsEl;
let langBadge;
let filePathDisplay;
let autoDot;
let statusIcon;
let statusAction;
let statusReason;
let confidenceBar;
let confidenceFill;
let analyzeBtn;
let applyBtn;

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

// ─── Model Picker ──────────────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function renderModelDropdown() {
  const list = document.getElementById('modelDropList');
  if (!list) return;

  if (!_models.length) {
    list.innerHTML = '<div class="model-drop-empty">No models configured.<br>Add one in Dashboard → Settings.</div>';
    return;
  }

  list.innerHTML = _models.map(m => {
    const label = m.modelId.split('/').pop() || m.modelId;
    const isActive = m.id === selectedModelId;
    return `<div class="model-opt${isActive ? ' active' : ''}" data-id="${escHtml(m.id)}">
      <div class="model-opt-dot"></div>
      <div class="model-opt-info">
        <div class="model-opt-name" title="${escHtml(m.modelId)}">${escHtml(label)}</div>
        <div class="model-opt-prov">${escHtml(m.provider)}</div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.model-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      selectedModelId = opt.dataset.id;
      renderModelDropdown();
      setModelDropdown(false);
      updateActiveModelChip();
    });
  });
}

function setModelDropdown(show) {
  const drop = document.getElementById('modelDropdown');
  if (!drop) return;
  drop.style.display = show ? '' : 'none';
}

function updateActiveModelChip() {
  const chip = document.getElementById('activeModelChip');
  const label = document.getElementById('activeModelLabel');
  if (!chip || !label) return;

  const m = _models.find(x => x.id === selectedModelId);
  if (m) {
    const short = m.modelId.split('/').pop() || m.modelId;
    label.textContent = short;
    chip.title = `${m.modelId} (${m.provider}) — click to change`;
  } else if (_models.length) {
    label.textContent = 'Pick model';
  } else {
    label.textContent = 'No model';
  }
}

async function loadModels() {
  try {
    const settings = await requireCodeply().getSettings();
    _models = (settings.modelRanking || []).filter(m => m.modelId && m.apiKey);
    // Auto-select first model if nothing selected or selected model gone
    if (!selectedModelId || !_models.find(m => m.id === selectedModelId)) {
      selectedModelId = _models.length ? _models[0].id : null;
    }
    renderModelDropdown();
    updateActiveModelChip();
  } catch {}
}

function initPopupRenderer() {
  previewEl = document.getElementById('preview');
  lineNumsEl = document.getElementById('lineNumbers');
  langBadge = document.getElementById('langBadge');
  filePathDisplay = document.getElementById('filePathDisplay');
  autoDot = document.getElementById('autoDot');
  statusIcon = document.getElementById('statusIcon');
  statusAction = document.getElementById('statusAction');
  statusReason = document.getElementById('statusReason');
  confidenceBar = document.getElementById('confidenceBar');
  confidenceFill = document.getElementById('confidenceFill');
  analyzeBtn = document.getElementById('analyzeBtn');
  applyBtn = document.getElementById('applyBtn');

  const codeply = requireCodeply();

// ─── Clipboard / Snippet Update ────────────────────────────────────────────────
codeply.onSnippetUpdate((snippet) => {
  if (!snippet) return;
  const code = snippet.text || snippet.preview || '';
  currentCode = code;
  analysisResult = null;
  applyBtn.disabled = true;
  const _mb = document.getElementById('modelBadge'); if (_mb) _mb.style.display = 'none';

  renderCode(code);
  langBadge.textContent = snippet.language || '–';

  const isCode = snippet.isCode !== undefined ? snippet.isCode : !!code;
  analyzeBtn.disabled = !isCode;

  const kind = snippet.kind || (isCode ? 'code' : 'none');

  if (kind === 'replace') {
    const target = currentFile ? ` → ${currentFile.split(/[\\/]/).pop()}` : '';
    setStatus('idle', 'Full replace' + target, snippet.summary || 'Analyze to overwrite the whole file.');
    langBadge.style.color = 'var(--accent)';
    setTimeout(() => { langBadge.style.color = ''; }, 700);
  } else if (kind === 'instruction') {
    const target = currentFile ? ` → ${currentFile.split(/[\\/]/).pop()}` : '';
    setStatus('idle', 'Instruction detected' + target, snippet.summary || 'Target a file, then hit Analyze to apply it.');
    langBadge.style.color = 'var(--accent)';
    setTimeout(() => { langBadge.style.color = ''; }, 700);
  } else if (kind === 'code') {
    const target = currentFile ? ` → ${currentFile.split(/[\\/]/).pop()}` : '';
    setStatus('idle', 'Code detected' + target, snippet.summary || 'Hit Analyze to find exact placement');
    langBadge.style.color = 'var(--green)';
    setTimeout(() => { langBadge.style.color = ''; }, 700);
  } else {
    setStatus('idle', 'Waiting for code', snippet.summary || 'Copy code or type an instruction — plain text is ignored.');
  }
});

function renderCode(code) {
  if (!code) {
    previewEl.textContent = '// Copy code OR type an instruction (e.g. "remove all headings"), then Analyze...';
    lineNumsEl.innerHTML = '';
    return;
  }
  const lines = code.split('\n');
  previewEl.textContent = code;
  lineNumsEl.innerHTML = lines.map((_, i) =>
    `<div class="line-num" id="ln${i + 1}">${i + 1}</div>`
  ).join('');
}

// ─── Active-file auto-detection ─────────────────────────────────────────────────
async function setTargetFile(filePath, { manual = false } = {}) {
  currentFile = filePath;
  manualLock = manual;
  const fileData = filePath ? await requireCodeply().readFile(filePath) : null;
  fileContent = fileData ? fileData.content : null;

  if (filePath) {
    const name = filePath.split(/[\\/]/).pop();
    const short = filePath.length > 38 ? '…' + filePath.slice(-36) : filePath;
    filePathDisplay.textContent = manual ? short : name;
    filePathDisplay.classList.add('active');
    filePathDisplay.title = filePath;
    autoDot.classList.toggle('live', !manual);
  } else {
    autoDot.classList.remove('live');
  }
  analysisResult = null;
  applyBtn.disabled = true;
}

// ── Model fallback toast ──────────────────────────────────────────────────────
function showFallbackToast(failed, used) {
  // Remove any existing toast
  const existing = document.querySelector('.fallback-toast');
  if (existing) existing.remove();

  const failedNames = Array.isArray(failed) ? failed.join(', ') : failed;

  const toast = document.createElement('div');
  toast.className = 'fallback-toast';
  toast.innerHTML = `
    <div class="ft-row">
      <span class="ft-icon">⚠️</span>
      <div class="ft-body">
        <div class="ft-title">Couldn't load <span class="ft-detail">${failedNames}</span></div>
        <div class="ft-detail">Reason: invalid or missing API key</div>
        <div class="ft-detail">Instead used: <span class="ft-used">${used}</span></div>
      </div>
    </div>`;

  document.body.appendChild(toast);

  // Dismiss on click
  toast.addEventListener('click', () => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 200);
  });

  // Auto-dismiss after 6s
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 200);
  }, 6000);
}

window.codeply.onModelFallback(({ failed, used }) => {
  showFallbackToast(failed, used);
});

// Auto-detected target file pushed from main (most-recently-edited file in folder).
codeply.onActiveFile((f) => {
  if (manualLock) return;            // don't stomp a hand-picked file
  if (!f || !f.path) {
    autoDot.classList.remove('live');
    return;
  }
  if (f.path === currentFile) return;
  setTargetFile(f.path, { manual: false });
  setStatus('idle', `Targeting ${f.name}`, `${f.lineCount} lines — auto-detected. Hit Analyze.`);
});

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

// ─── Manual file pick (locks auto-detect) ──────────────────────────────────────
bindClick('browseBtn', async () => {
  const filePath = await codeply.browseFile();
  if (!filePath) return;
  await setTargetFile(filePath, { manual: true });
  const lc = fileContent ? fileContent.split('\n').length : '?';
  setStatus('idle', 'File locked', `${lc} lines — auto-detect paused. Hit Analyze.`);
});

// ─── Watch folder (enables auto-detect) ─────────────────────────────────────────
bindClick('watchBtn', async () => {
  const folder = await codeply.pickWatchFolder();
  if (!folder) return;
  manualLock = false;
  autoDot.classList.add('live');
  filePathDisplay.textContent = 'Watching… edit & save a file to target it';
  filePathDisplay.classList.remove('active');
  setStatus('idle', 'Folder watched', 'Save a file in your editor and it auto-targets here.');
});

// ─── Friendly error messages ───────────────────────────────────────────────────
function friendlyError(raw) {
  const s = String(raw).toLowerCase();
  const detail = String(raw).slice(0, 120); // show up to 120 chars of raw error for debugging

  // ① No API key set — check this FIRST (most common cause of fetch failures)
  if (!_apiKey)
    return { title: 'No API key', msg: 'Add your API key in Dashboard → Settings, then save.' };

  // ② Credits / billing
  if (s.includes('credits') || s.includes('afford') || s.includes('billing') || s.includes('payment'))
    return { title: 'Not enough credits', msg: 'Top up your API credits or switch to a free model like laguna-xs.2.' };

  // ③ Rate limit
  if (s.includes('rate limit') || s.includes('ratelimit') || s.includes('too many request') || s.includes('429'))
    return { title: 'Rate limited', msg: 'Too many requests — wait a moment and try again.' };

  // ④ Auth / key invalid
  if (s.includes('api key') || s.includes('apikey') || s.includes('unauthorized') || s.includes('401') || s.includes('invalid key') || s.includes('authentication') || s.includes('forbidden') || s.includes('403'))
    return { title: 'Invalid API key', msg: 'Your API key was rejected. Double-check it in Dashboard → Settings.' };

  // ⑤ Timeout
  if (s.includes('timeout') || s.includes('timed out') || s.includes('etimedout'))
    return { title: 'Request timed out', msg: 'The AI took too long — try again or switch to a faster model.' };

  // ⑥ Model / endpoint not found
  if (s.includes('no endpoints') || s.includes('model not found') || s.includes('invalid model') || s.includes('does not exist') || (s.includes('404') && !s.includes('api key')))
    return { title: 'Model not found', msg: 'This model isn\'t available on your provider. Try a different one in Dashboard → Settings.' };

  // ⑦ Token / context limit
  if (s.includes('max_tokens') || s.includes('context length') || s.includes('too long') || (s.includes('token') && s.includes('limit')))
    return { title: 'Code too long', msg: 'Snippet is too large for this model. Try a smaller selection.' };

  // ⑧ Server error
  if (s.includes('500') || s.includes('502') || s.includes('503') || s.includes('server error') || s.includes('internal error'))
    return { title: 'Server error', msg: `The AI provider is having issues — try again shortly. (${detail})` };

  // ⑨ Network / connection — only after all other checks
  if (s.includes('enotfound') || s.includes('econnrefused') || s.includes('econnreset') || s.includes('failed to fetch') || s.includes('networkerror') || s.includes('network error') || s.includes('offline'))
    return { title: 'Connection failed', msg: `Could not reach the API. Check your internet, firewall, or API base URL. (${detail})` };

  // ⑩ Generic fallback — show the raw error so user can diagnose
  return { title: 'Analysis failed', msg: detail || 'Unknown error. Check your API key and model in Dashboard → Settings.' };
}

// ─── Token Cap Enforcement ─────────────────────────────────────────────────────
let _tokenCap = 0;
let _apiKey = '';
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
        `${_fmtN(used)} / ${_fmtN(_tokenCap)} tokens used. Raise or reset cap in Dashboard → Settings.`);
      analyzeBtn.disabled = true;
      return false;
    }
  } catch { /* fail open */ }
  return true;
}

// ─── Analyze ───────────────────────────────────────────────────────────────────
bindClick('analyzeBtn', async () => {
  if (!await checkTokenCap()) return;

  if (!currentCode || currentCode.trim().startsWith('//')) {
    setStatus('error', 'No code copied', 'Copy some AI-generated code first');
    return;
  }

  analyzeBtn.textContent = 'Analyzing…';
  analyzeBtn.disabled = true;
  applyBtn.disabled = true;

  // Pulse the status icon
  statusIcon.innerHTML = '<span class="spin-icon">◌</span>';
  setStatus('analyzing', 'AI analyzing placement…', currentFile
    ? `Scanning ${currentFile.split('/').pop() || currentFile.split('\\').pop()}…`
    : 'No file loaded — will suggest placement type');

  const result = await codeply.analyzeSnippet({
    code: currentCode,
    filePath: currentFile,
    selectedModelId
  });

  analyzeBtn.textContent = 'Analyze';
  analyzeBtn.disabled = false;

  if (!result.success) {
    const { title, msg } = friendlyError(result.error || '');
    setStatus('error', title, msg);
    const mb = document.getElementById('modelBadge'); if (mb) mb.style.display = 'none';
    return;
  }

  // Show which model handled this request
  const mb = document.getElementById('modelBadge');
  if (mb) {
    if (result.modelUsed) { mb.textContent = `via ${result.modelUsed}`; mb.style.display = 'block'; }
    else mb.style.display = 'none';
  }

  analysisResult = result.result;
  const r = analysisResult;

  // Detect AI failure that leaked into a "successful" offline result
  const reasonHasError = r.reason && /offline|fetch failed|failed to fetch|credits|used offline|no endpoint|not found|afford|max_token|rate limit|unauthorized|forbidden|api key|server error|timed out|enotfound|econnrefused/i.test(r.reason);
  if (reasonHasError) {
    const { title, msg } = friendlyError(r.reason);
    setStatus('error', title, msg);
    applyBtn.disabled = true;
    return;
  }

  // Highlight target lines in preview if we have a file open
  if (currentFile && fileContent && (r.action === 'replace' || r.action === 'insert_after' || r.action === 'insert_before')) {
    renderFileWithHighlight(fileContent, r.startLine, r.endLine);
  } else if (currentFile && fileContent && r.action === 'delete' && r.deleteLines) {
    renderFileWithHighlight(fileContent, r.deleteLines[0], r.deleteLines[r.deleteLines.length - 1]);
  }

  const actionLabel = {
    replace: `Replace lines ${r.startLine}–${r.endLine}`,
    insert_after: `Insert after line ${r.startLine}`,
    insert_before: `Insert before line ${r.startLine}`,
    append: 'Append to end of file',
    delete: `Delete ${r.deleteLines ? r.deleteLines.length : 0} line(s)`,
    rewrite: 'Overwrite entire file',
    none: 'No change'
  }[r.action] || r.action;

  if (r.action === 'none') {
    setStatus('error', actionLabel, r.reason, r.confidence);
    applyBtn.disabled = true;
    return;
  }

  setStatus('ready', actionLabel, r.reason, r.confidence);
  applyBtn.disabled = false;
  applyBtn.textContent = 'Apply';
});

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
bindClick('applyBtn', async () => {
  if (!analysisResult || applyBtn.disabled) return;

  const r = analysisResult;

  if (r.action === 'none') return;

  // ── Delete / whole-file rewrite: apply then refresh the preview ──
  if (r.action === 'delete' || r.action === 'rewrite') {
    applyBtn.textContent = 'Applying…';
    applyBtn.disabled = true;
    analyzeBtn.disabled = true;
    setStatus('applying', 'Applying changes…', 'Writing to file…');

    const res = await codeply.applyToFile({ filePath: currentFile, result: r });
    if (!res.success) {
      setStatus('error', 'Apply failed', res.error);
      applyBtn.textContent = 'Apply'; applyBtn.disabled = false; analyzeBtn.disabled = false;
      return;
    }
    const updated = await codeply.readFile(currentFile);
    fileContent = updated ? updated.content : fileContent;
    renderFileWithHighlight(fileContent, null, null);

    const fname = currentFile.split('/').pop() || currentFile.split('\\').pop();
    setStatus('ready', 'Applied!', `Changes written to ${fname}`, 100);
    applyBtn.textContent = 'Apply';
    analyzeBtn.disabled = false;
    analysisResult = null;
    applyBtn.disabled = true;
    return;
  }

  if (!currentFile) {
    // No file — just animate the paste in the preview
    await animateCodeInPreview(r.code, null, null);
    setStatus('ready', 'Done!', 'No file selected — showing preview animation only');
    return;
  }

  applyBtn.textContent = 'Applying…';
  applyBtn.disabled = true;
  analyzeBtn.disabled = true;
  setStatus('applying', 'Applying changes…', 'Writing to file…');

  // 1. Show red overlay on old code in preview
  if (fileContent) {
    await animateRedOverlay(r.startLine, r.endLine);
  }

  // 2. Apply to file
  const result = await codeply.applyToFile({ filePath: currentFile, result: r });

  if (!result.success) {
    setStatus('error', 'Apply failed', result.error);
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = false;
    analyzeBtn.disabled = false;
    return;
  }

  // 3. Read updated file
  const updated = await codeply.readFile(currentFile);
  fileContent = updated ? updated.content : fileContent;

  // 4. Typewriter animation of new code
  await animateCodeInPreview(r.code, r.startLine, r.endLine);

  setStatus('ready', 'Applied!', `Changes written to ${currentFile.split('/').pop() || currentFile.split('\\').pop()}`, 100);
  applyBtn.textContent = 'Apply';
  analyzeBtn.disabled = false;
  analysisResult = null;
  applyBtn.disabled = true;
});

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

bindClick('reloadBtn', () => {
  const btn = document.getElementById('reloadBtn');
  btn.classList.add('spinning');
  codeply.refreshSnippet();
  setTimeout(() => btn.classList.remove('spinning'), 600);
});

bindClick('modelPickBtn', () => {
  const drop = document.getElementById('modelDropdown');
  if (!drop) return;
  const showing = drop.style.display !== 'none';
  setModelDropdown(!showing);
});

bindClick('activeModelChip', () => {
  const drop = document.getElementById('modelDropdown');
  if (!drop) return;
  const showing = drop.style.display !== 'none';
  setModelDropdown(!showing);
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const drop = document.getElementById('modelDropdown');
  const btn  = document.getElementById('modelPickBtn');
  const chip = document.getElementById('activeModelChip');
  if (drop && drop.style.display !== 'none' &&
      !drop.contains(e.target) && e.target !== btn && !btn?.contains(e.target) &&
      e.target !== chip && !chip?.contains(e.target)) {
    setModelDropdown(false);
  }
});

// Settings managed via Dashboard — no settings panel in renderer.

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
      analyzeBtn.disabled = true;
      applyBtn.disabled   = true;
    }
  } catch { /* fail-open */ }
}

bindClick('popupPaywallBtn', () => codeply.openDashboard());

  // ─── Init ──────────────────────────────────────────────────────────────────────
  (async () => {
    try {
      const settings = await codeply.getSettings();
      if (settings) {
        // Store token cap and API key for enforcement
        _tokenCap = parseInt(settings.tokenCap || 0, 10) || 0;
        _apiKey   = settings.apiKey || '';
        if (window._seedSettings) {
          window._seedSettings(settings.provider, settings.model, settings.apiKey);
        }
      }
    } catch (e) { console.error(e); }

    // Load model list for picker
    await loadModels();
    // Run cap check on startup so analyzeBtn is blocked immediately if over cap
    await checkTokenCap();

    // Hot-reload the API key + model list the moment Settings are saved in the
    // dashboard — no app restart required.
    codeply.onSettingsUpdated?.(async (s) => {
      try {
        if (s) _apiKey = s.apiKey || _apiKey;
        await loadModels();
        await checkTokenCap();
      } catch (e) { console.error('[Codeply popup] settings hot-reload failed:', e); }
    });

    try {
      const w = await codeply.getWatch();
      if (w && w.folder) {
        autoDot.classList.add('live');
        if (w.activeFile) {
          await setTargetFile(w.activeFile, { manual: false });
        } else {
          filePathDisplay.textContent = 'Watching… save a file to target it';
        }
      }
    } catch (e) { console.error(e); }

    codeply.refreshSnippet();
    checkSubscriptionAndBlock();
  })();
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    initPopupRenderer();
  } catch (e) {
    console.error('[Codeply popup] init failed:', e);
  }
});
