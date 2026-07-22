/**
 * Codeply — per-project store (.codeply/)
 *
 * Owns everything that lives inside <projectRoot>/.codeply/:
 *   cache/    — Groq response cache, keyed by SHA-256(fileContent + prompt)
 *   history/  — pre-edit snapshots of files the AI touched (revertable)
 *   config.json — detected framework + misc project config
 *
 * Also: silently gitignores .codeply/ in git projects, expires cache entries
 * after 7 days, and caps the whole .codeply/ folder at 50MB (oldest cache
 * entries die first, then oldest history snapshots). Only files Codeply itself
 * wrote inside .codeply/ are ever deleted.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const MAX_STORE_BYTES = 50 * 1024 * 1024;        // 50MB total .codeply/ cap
const MAX_VERSIONS_PER_FILE = 10;

let projectRoot = null;   // current project folder (the watch folder)

const dir = (...p) => path.join(projectRoot, '.codeply', ...p);

function ensureDirs() {
  fs.mkdirSync(dir('cache'), { recursive: true });
  fs.mkdirSync(dir('history'), { recursive: true });
}

function isReady() { return !!projectRoot; }
function getRoot() { return projectRoot; }

/**
 * Point the store at a project folder. Creates .codeply/, purges expired
 * cache entries, enforces the size cap and gitignores itself — all silent.
 */
function init(root) {
  if (!root || !fs.existsSync(root)) { projectRoot = null; return; }
  projectRoot = root;
  try {
    ensureDirs();
    purgeExpiredCache();
    ensureGitignored();
    enforceSizeCap();
  } catch (e) {
    console.warn('[codeply-store] init failed:', e.message);
    projectRoot = null;
  }
}

// ── Config (framework etc.) ───────────────────────────────────────────────────

function readConfig() {
  if (!isReady()) return {};
  try { return JSON.parse(fs.readFileSync(dir('config.json'), 'utf8')); }
  catch { return {}; }
}

function writeConfig(patch) {
  if (!isReady()) return;
  try {
    const cfg = { ...readConfig(), ...patch };
    fs.writeFileSync(dir('config.json'), JSON.stringify(cfg, null, 2));
  } catch (e) { console.warn('[codeply-store] config write failed:', e.message); }
}

// ── Response cache ────────────────────────────────────────────────────────────

function cacheKey(fileContent, prompt) {
  return crypto.createHash('sha256')
    .update(String(fileContent || ''), 'utf8')
    .update(String(prompt || ''), 'utf8')
    .digest('hex');
}

function cacheGet(fileContent, prompt) {
  if (!isReady()) return null;
  const key = cacheKey(fileContent, prompt);
  const file = dir('cache', key + '.json');
  try {
    if (!fs.existsSync(file)) return null;
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (entry.timestamp || 0) > CACHE_TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }
    return entry.response;
  } catch { return null; }
}

function cacheSet(fileContent, prompt, response, filePath) {
  if (!isReady()) return;
  const key = cacheKey(fileContent, prompt);
  try {
    fs.writeFileSync(dir('cache', key + '.json'), JSON.stringify({
      promptHash: key,
      response,
      timestamp: Date.now(),
      filePath: filePath || '',
    }));
    enforceSizeCap();
  } catch (e) { console.warn('[codeply-store] cache write failed:', e.message); }
}

function purgeExpiredCache() {
  const cacheDir = dir('cache');
  let names;
  try { names = fs.readdirSync(cacheDir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(cacheDir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - (entry.timestamp || 0) > CACHE_TTL_MS) fs.unlinkSync(file);
    } catch {
      // Unreadable cache entry — safe to drop, it's ours.
      try { fs.unlinkSync(file); } catch { }
    }
  }
}

// ── File history (pre-edit snapshots) ─────────────────────────────────────────

// history filename: <relpath with separators flattened>.<epoch-ms>.bak
function historyBaseName(filePath) {
  const rel = path.relative(projectRoot, filePath);
  return rel.split(/[\\/]/).join('__');
}

/** Snapshot the CURRENT contents of filePath before the AI overwrites it. */
function saveSnapshot(filePath) {
  if (!isReady() || !filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;              // new file — nothing to snapshot
    const rel = path.relative(projectRoot, filePath);
    if (rel.startsWith('..')) return;                  // outside the project — don't track
    const base = historyBaseName(filePath);
    fs.copyFileSync(filePath, dir('history', `${base}.${Date.now()}.bak`));
    trimSnapshots(base);
    enforceSizeCap();
  } catch (e) { console.warn('[codeply-store] snapshot failed:', e.message); }
}

function snapshotsFor(base) {
  let names;
  try { names = fs.readdirSync(dir('history')); } catch { return []; }
  return names
    .filter(n => n.startsWith(base + '.') && n.endsWith('.bak'))
    .map(n => {
      const ts = parseInt(n.slice(base.length + 1, -4), 10);
      return { name: n, timestamp: Number.isFinite(ts) ? ts : 0 };
    })
    .sort((a, b) => b.timestamp - a.timestamp);        // newest first
}

/** Keep only the newest MAX_VERSIONS_PER_FILE snapshots of one file. */
function trimSnapshots(base) {
  for (const s of snapshotsFor(base).slice(MAX_VERSIONS_PER_FILE)) {
    try { fs.unlinkSync(dir('history', s.name)); } catch { }
  }
}

/** List snapshots for a file (for the revert UI). */
function listSnapshots(filePath) {
  if (!isReady() || !filePath) return [];
  const rel = path.relative(projectRoot, filePath);
  if (rel.startsWith('..')) return [];
  return snapshotsFor(historyBaseName(filePath)).map(s => ({
    name: s.name,
    timestamp: s.timestamp,
    size: (() => { try { return fs.statSync(dir('history', s.name)).size; } catch { return 0; } })(),
  }));
}

/**
 * Restore a snapshot over the live file. The current version is snapshotted
 * first so a revert is itself revertable.
 */
function revertToSnapshot(filePath, snapshotName) {
  if (!isReady() || !filePath || !snapshotName) return { success: false, error: 'Nothing to revert.' };
  // The name must be one we generated — refuse anything path-like.
  if (/[\\/]/.test(snapshotName) || !snapshotName.endsWith('.bak')) {
    return { success: false, error: 'Invalid snapshot.' };
  }
  const snap = dir('history', snapshotName);
  try {
    if (!fs.existsSync(snap)) return { success: false, error: 'Snapshot no longer exists.' };
    saveSnapshot(filePath);                            // make the revert undoable
    const content = fs.readFileSync(snap, 'utf8');
    const tmp = filePath + '.__codeply_tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// ── Git integration ───────────────────────────────────────────────────────────

/** If the project is a git repo, silently add .codeply/ to its .gitignore. */
function ensureGitignored() {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return;
  const gi = path.join(projectRoot, '.gitignore');
  try {
    let content = '';
    try { content = fs.readFileSync(gi, 'utf8'); } catch { }
    const already = content.split('\n').some(l => {
      const t = l.trim();
      return t === '.codeply' || t === '.codeply/' || t === '/.codeply' || t === '/.codeply/';
    });
    if (already) return;
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gi, `${sep}.codeply/\n`);
    console.log('[codeply-store] added .codeply/ to .gitignore');
  } catch (e) { console.warn('[codeply-store] gitignore update failed:', e.message); }
}

// ── Disk safety (50MB cap) ────────────────────────────────────────────────────

function enforceSizeCap() {
  try {
    const collect = (d) => {
      let out = [];
      try {
        for (const name of fs.readdirSync(d)) {
          const full = path.join(d, name);
          const st = fs.statSync(full);
          if (st.isFile()) out.push({ full, size: st.size, mtime: st.mtimeMs });
        }
      } catch { }
      return out;
    };
    const cacheFiles = collect(dir('cache'));
    const historyFiles = collect(dir('history'));
    let total = [...cacheFiles, ...historyFiles].reduce((s, f) => s + f.size, 0);
    if (total <= MAX_STORE_BYTES) return;

    // Oldest cache entries first, then oldest history snapshots.
    const kill = [
      ...cacheFiles.sort((a, b) => a.mtime - b.mtime),
      ...historyFiles.sort((a, b) => a.mtime - b.mtime),
    ];
    for (const f of kill) {
      if (total <= MAX_STORE_BYTES) break;
      try { fs.unlinkSync(f.full); total -= f.size; } catch { }
    }
    console.log('[codeply-store] size cap enforced, .codeply/ trimmed');
  } catch (e) { console.warn('[codeply-store] size cap check failed:', e.message); }
}

module.exports = {
  init, isReady, getRoot,
  readConfig, writeConfig,
  cacheGet, cacheSet,
  saveSnapshot, listSnapshots, revertToSnapshot,
};
