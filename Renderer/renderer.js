/**
 * Codeply AI — Popup Renderer
 * Clipboard sync · auto-detected active file · AI analyze · animated apply
 */

let currentCode = '';
let currentFile = null;       // full path of auto-detected active file
let analysisResult = null;
let fileContent = null;

// ─── Elements ──────────────────────────────────────────────────────────────────
const previewEl = document.getElementById('preview');
const lineNumsEl = document.getElementById('lineNumbers');
const langBadge = document.getElementById('langBadge');
const detectPill = document.getElementById('detectPill');
const detectFile = document.getElementById('detectFile');
const detectMeta = document.getElementById('detectMeta');
const statusIcon = document.getElementById('statusIcon');
const statusAction = document.getElementById('statusAction');
const statusReason = document.getElementById('statusReason');
const confidenceBar = document.getElementById('confidenceBar');
const confidenceFill = document.getElementById('confidenceFill');
const analyzeBtn = document.getElementById('analyzeBtn');
const applyBtn = document.getElementById('applyBtn');
const settingsPanel = document.getElementById('settingsPanel');

// ─── Auto-detected active file ──────────────────────────────────────────────────
// main.js reads the focused IDE window title every time the overlay opens and
// pushes { path, name, lineCount, ide } here. The user never picks a file.
window.codeply.onActiveFile((file) => {
  if (file && file.name) {
    currentFile = file.path || null;
    fileContent = file.content != null ? file.content : null;

    detectPill.classList.remove('empty');
    detectFile.textContent = file.name;
    detectMeta.textContent = file.ide || (fileContent ? `${fileContent.split('\n').length} lines` : '');
  } else {
    currentFile = null;
    fileContent = null;
    detectPill.classList.add('empty');
    detectFile.textContent = 'No active file detected';
    detectMeta.textContent = '';
  }

  // Re-arm apply state since the target may have changed
  analysisResult = null;
  applyBtn.disabled = true;
});

// ─── Clipboard / Snippet Update ────────────────────────────────────────────────
window.codeply.onSnippetUpdate((snippet) => {
  if (!snippet) return;
  const code = snippet.text || snippet.preview || '';
  currentCode = code;
  analysisResult = null;
  applyBtn.disabled = true;

  renderCode(code);
  langBadge.textContent = snippet.language || '–';
  setStatus('idle', 'Ready to analyze', snippet.summary || 'Hit Analyze to find exact placement');
});

function renderCode(code) {
  if (!code) {
    previewEl.classList.add('placeholder');
    previewEl.textContent = '// Copy AI-generated code, then hit Analyze…';
    lineNumsEl.innerHTML = '';
    return;
  }
  previewEl.classList.remove('placeholder');
  const lines = code.split('\n');
  previewEl.textContent = code;
  lineNumsEl.innerHTML = lines.map((_, i) =>
    `<div class="line-num" id="ln${i + 1}">${i + 1}</div>`
  ).join('');
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

// ─── Analyze ───────────────────────────────────────────────────────────────────
analyzeBtn.onclick = async () => {
  if (!currentCode || currentCode.trim().startsWith('//')) {
    setStatus('error', 'No code copied', 'Copy some AI-generated code first');
    return;
  }

  analyzeBtn.textContent = 'Analyzing…';
  analyzeBtn.disabled = true;
  applyBtn.disabled = true;

  statusIcon.innerHTML = '<span class="spin-icon">◌</span>';
  setStatus('analyzing', 'AI analyzing placement…', currentFile
    ? `Scanning ${currentFile.split('/').pop() || currentFile.split('\\').pop()}…`
    : 'No active file detected — will suggest placement type');

  const result = await window.codeply.analyzeSnippet({
    code: currentCode,
    filePath: currentFile
  });

  analyzeBtn.textContent = 'Analyze';
  analyzeBtn.disabled = false;

  if (!result.success) {
    setStatus('error', 'Analysis failed', result.error || 'Unknown error');
    return;
  }

  analysisResult = result.result;
  const r = analysisResult;

  if (currentFile && fileContent) {
    renderFileWithHighlight(fileContent, r.startLine, r.endLine);
  }

  const actionLabel = {
    replace: `Replace lines ${r.startLine}–${r.endLine}`,
    insert_after: `Insert after line ${r.startLine}`,
    insert_before: `Insert before line ${r.startLine}`,
    append: 'Append to end of file'
  }[r.action] || r.action;

  setStatus('ready', actionLabel, r.reason, r.confidence);
  applyBtn.disabled = false;
  applyBtn.textContent = 'Apply';
};

// ─── Render file with highlight ────────────────────────────────────────────────
function renderFileWithHighlight(content, startLine, endLine) {
  const lines = content.split('\n');
  previewEl.classList.remove('placeholder');
  previewEl.textContent = content;

  lineNumsEl.innerHTML = lines.map((_, i) => {
    const ln = i + 1;
    const isTarget = startLine && endLine
      ? ln >= startLine && ln <= endLine
      : ln === startLine;
    return `<div class="line-num${isTarget ? ' highlight' : ''}" id="ln${ln}">${ln}</div>`;
  }).join('');

  if (startLine) {
    const lineHeight = 24;
    previewEl.scrollTop = Math.max(0, (startLine - 3) * lineHeight);
  }
}

// ─── Apply with Animation ──────────────────────────────────────────────────────
applyBtn.onclick = async () => {
  if (!analysisResult || applyBtn.disabled) return;
  const r = analysisResult;

  if (!currentFile) {
    await animateCodeInPreview(r.code, null, null);
    setStatus('ready', 'Preview only', 'No active file detected — showing placement preview only');
    return;
  }

  applyBtn.textContent = 'Applying…';
  applyBtn.disabled = true;
  analyzeBtn.disabled = true;
  setStatus('applying', 'Applying changes…', 'Writing to file…');

  if (fileContent) {
    await animateRedOverlay(r.startLine, r.endLine);
  }

  const result = await window.codeply.applyToFile({ filePath: currentFile, result: r });

  if (!result.success) {
    setStatus('error', 'Apply failed', result.error);
    applyBtn.textContent = 'Apply';
    applyBtn.disabled = false;
    analyzeBtn.disabled = false;
    return;
  }

  const updated = await window.codeply.readFile(currentFile);
  fileContent = updated ? updated.content : fileContent;

  await animateCodeInPreview(r.code, r.startLine, r.endLine);

  setStatus('ready', 'Applied!', `Changes written to ${currentFile.split('/').pop() || currentFile.split('\\').pop()}`, 100);
  applyBtn.textContent = 'Apply';
  analyzeBtn.disabled = false;
  analysisResult = null;
  applyBtn.disabled = true;
};

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
    overlay.style.cssText = `top:${top + 13}px; height:${height}px; opacity:0; transition: opacity 0.2s;`;
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
    const lines = code.split('\n');
    const baseContent = fileContent || '';
    const baseLines = baseContent.split('\n');

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

    previewEl.classList.remove('placeholder');
    previewEl.textContent = allLines.join('\n');
    lineNumsEl.innerHTML = allLines.map((_, i) => {
      const ln = i + 1;
      const isNew = ln >= insertStart && ln <= insertEnd;
      return `<div class="line-num${isNew ? ' highlight' : ''}" id="ln${ln}">${ln}</div>`;
    }).join('');

    const top = (insertStart - 1) * lineHeight;
    const height = lines.length * lineHeight;

    const greenOverlay = document.createElement('div');
    greenOverlay.className = 'code-line-overlay overlay-green';
    greenOverlay.style.cssText = `top:${top + 13}px; height:${height}px; opacity:0; transition: opacity 0.3s;`;
    document.getElementById('previewWrap').appendChild(greenOverlay);

    const beforeText = beforeLines.join('\n') + (beforeLines.length ? '\n' : '');
    const afterText = (afterLines.length ? '\n' : '') + afterLines.join('\n');
    const fullCode = code;
    let charIndex = 0;
    const totalChars = fullCode.length;
    const charsPerFrame = Math.max(1, Math.ceil(totalChars / 40));

    previewEl.textContent = beforeText;
    requestAnimationFrame(() => { greenOverlay.style.opacity = '1'; });

    if (startLine) previewEl.scrollTop = Math.max(0, (insertStart - 3) * lineHeight);

    function typeNext() {
      charIndex += charsPerFrame;
      const typed = fullCode.slice(0, charIndex);
      previewEl.textContent = beforeText + typed + (charIndex < totalChars ? '|' : '') + afterText;

      if (charIndex < totalChars) {
        requestAnimationFrame(typeNext);
      } else {
        previewEl.textContent = beforeText + fullCode + afterText;
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
document.getElementById('dismissBtn').onclick = () => window.codeply.dismiss();
document.getElementById('minimizeBtn').onclick = () => window.codeply.minimize();
document.getElementById('dashBtn').onclick = () => window.codeply.openDashboard();

document.getElementById('reloadBtn').onclick = () => {
  const btn = document.getElementById('reloadBtn');
  btn.classList.add('spinning');
  window.codeply.refreshSnippet();
  setTimeout(() => btn.classList.remove('spinning'), 600);
};

document.getElementById('settingsBtn').onclick = () => {
  settingsPanel.classList.toggle('open');
};

// ─── Settings ──────────────────────────────────────────────────────────────────
const defaultModels = { openrouter: 'openai/gpt-4o-mini', groq: 'llama-3.1-8b-instant' };

document.getElementById('provider').addEventListener('change', (e) => {
  document.getElementById('model').value = defaultModels[e.target.value] || '';
});

document.getElementById('saveBtn').onclick = async () => {
  const saveBtn = document.getElementById('saveBtn');
  await window.codeply.saveSettings({
    provider: document.getElementById('provider').value,
    model: document.getElementById('model').value,
    apiKey: document.getElementById('apiKey').value
  });
  saveBtn.textContent = 'Saved ✓';
  setTimeout(() => {
    saveBtn.textContent = 'Save';
    settingsPanel.classList.remove('open');
  }, 1200);
};

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const settings = await window.codeply.getSettings();
    if (settings) {
      if (settings.provider) document.getElementById('provider').value = settings.provider;
      if (settings.model) document.getElementById('model').value = settings.model;
      if (settings.apiKey) document.getElementById('apiKey').value = settings.apiKey;
    }
  } catch (e) { console.error(e); }
  window.codeply.refreshSnippet();
  if (window.codeply.requestActiveFile) window.codeply.requestActiveFile();
});
