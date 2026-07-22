/**
 * Codeply — intelligent file detection & multi-file placement (Task 4)
 *
 * Figures out WHICH file(s) a copied snippet belongs to inside the watched
 * project, using: framework signature detection, a bounded file-tree scan,
 * and a Groq call (cached via project-store) that ranks candidate files with
 * a confidence level. Also produces AI-merged file contents for multi-file
 * apply, preserving untouched code.
 */
const fs = require('fs');
const path = require('path');
const groq = require('./groq');
const store = require('./project-store');

// Never scan these — huge, binary, or someone else's business.
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.codeply', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.vscode',
  'storage', 'bootstrap'
]);
const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.cs',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.yml', '.yaml', '.toml', '.md', '.txt', '.sql', '.sh', '.blade.php', '.twig', '.env'
]);

// ── Framework detection ───────────────────────────────────────────────────────

const has = (root, ...p) => fs.existsSync(path.join(root, ...p));

function readPkg(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch { return null; }
}

/** Detect the framework of ONE directory by its signature files. */
function detectFrameworkAt(root) {
  const pkg = readPkg(root);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};

  if (has(root, 'artisan') && has(root, 'composer.json')) return 'Laravel';
  if (has(root, 'manage.py')) return 'Django';
  if (deps.next || has(root, 'next.config.js') || has(root, 'next.config.mjs') || has(root, 'next.config.ts')) return 'Next.js';
  if (deps.nuxt) return 'Nuxt';
  if (deps['@angular/core']) return 'Angular';
  if (deps.svelte || deps['@sveltejs/kit']) return 'Svelte';
  if (deps.vue || has(root, 'vue.config.js')) return 'Vue';
  if (deps['react-native'] || deps.expo) return 'React Native';
  if (deps.react) return 'React';
  if (deps.express) return 'Express';
  if (deps.fastify) return 'Fastify';
  if (deps.electron) return 'Electron';
  if (has(root, 'Gemfile') && has(root, 'config', 'routes.rb')) return 'Rails';
  if (has(root, 'go.mod')) return 'Go';
  if (has(root, 'Cargo.toml')) return 'Rust';
  if (has(root, 'pyproject.toml') || has(root, 'requirements.txt')) return 'Python';
  if (has(root, 'composer.json')) return 'PHP';
  if (pkg) return 'Node.js';
  return null;   // plain HTML/CSS/JS project — extension matching only
}

/**
 * Detect frameworks for the project, monorepo-aware: checks the root, and if
 * immediate subdirs carry their own signature files, records them too.
 * Cached in .codeply/config.json so we don't re-scan every launch.
 */
function detectFrameworks(projectRoot, { force = false } = {}) {
  const cached = store.readConfig();
  if (!force && cached.frameworks && cached.frameworkScanRoot === projectRoot) {
    return cached.frameworks;
  }
  const frameworks = {};   // relDir ('.' = root) -> framework name
  const rootFw = detectFrameworkAt(projectRoot);
  if (rootFw) frameworks['.'] = rootFw;
  try {
    for (const ent of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || EXCLUDE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      const sub = path.join(projectRoot, ent.name);
      const fw = detectFrameworkAt(sub);
      // Only record sub-projects that declare themselves (package.json etc.)
      if (fw && (has(sub, 'package.json') || has(sub, 'composer.json') || has(sub, 'manage.py') || has(sub, 'go.mod') || has(sub, 'Cargo.toml'))) {
        frameworks[ent.name] = fw;
      }
    }
  } catch { }
  store.writeConfig({ frameworks, frameworkScanRoot: projectRoot, frameworkDetectedAt: new Date().toISOString() });
  return frameworks;
}

/** Primary framework badge for the UI ('.' entry wins, else first sub-project). */
function primaryFramework(frameworks) {
  if (!frameworks) return null;
  return frameworks['.'] || Object.values(frameworks)[0] || null;
}

// ── File tree scan ────────────────────────────────────────────────────────────

/**
 * Build a compact file listing. Top 3 levels by default for performance;
 * `deepDirs` lets a second pass descend further into specific folders when
 * the model needs it (framework dirs like app/Http/Controllers).
 */
function buildFileTree(root, { maxDepth = 3, maxFiles = 900, deepDirs = [] } = {}) {
  const files = [];
  const walk = (d, depth, rel) => {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= maxFiles) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        const allowDeep = deepDirs.some(dd => dd === relPath || dd.startsWith(relPath + '/') || relPath.startsWith(dd + '/') || relPath === dd);
        if (depth < maxDepth || allowDeep) walk(path.join(d, ent.name), depth + 1, relPath);
        else files.push(relPath + '/…');           // marker: unexpanded folder
      } else {
        const ext = ent.name.includes('.') ? '.' + ent.name.split('.').slice(1).join('.').toLowerCase() : '';
        const simpleExt = path.extname(ent.name).toLowerCase();
        if (TEXT_EXT.has(ext) || TEXT_EXT.has(simpleExt)) files.push(relPath);
      }
    }
  };
  walk(root, 0, '');
  return files;
}

// ── Explicit filename hint ────────────────────────────────────────────────────
// If the user's copied text plainly names a real file in the project ("add
// this to index.html", "// script.js", "inside style.css"), that beats any
// amount of grep/AI guessing — an explicit mention is the strongest possible
// signal and always takes priority.
const FILENAME_RE = /\b([\w.-]+\.(?:html?|jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|sass|less|py|rb|php|go|rs|java|kt|c|cpp|h|cs|json|sql|blade\.php))\b/gi;

function extractFileHint(text, root) {
  if (!text) return null;
  const mentioned = [...new Set([...text.matchAll(FILENAME_RE)].map(m => m[1]))];
  if (!mentioned.length) return null;

  // Cross-reference against files that actually exist — otherwise prose like
  // "e.g. foo.js" or a version string would false-positive as a hint.
  const tree = buildFileTree(root, { maxDepth: 6, maxFiles: 4000 });
  const byBasename = new Map();
  for (const relPath of tree) {
    const base = relPath.split('/').pop().toLowerCase();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(relPath);
  }

  for (const cand of mentioned) {
    const hits = byBasename.get(cand.toLowerCase());
    if (hits && hits.length === 1) return { path: hits[0], mentioned: cand };
  }
  return null;   // mentioned but ambiguous (matches 0 or 2+ files) — let detection decide
}

// ── Identifier extraction (grep seeds) ────────────────────────────────────────
// Pulls out names/tokens that should appear VERBATIM in the one file the
// snippet belongs to — the same first move a coding-agent harness makes
// (grep for the real symbol) before it ever reasons about folder conventions.
function extractIdentifiers(code) {
  const ids = new Set();
  const add = (v) => { if (v && v.length >= 3) ids.add(v); };

  // Declared functions/classes/consts/types across common languages.
  for (const m of code.matchAll(/\b(?:function|class|def|const|let|var|interface|type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // Arrow / function-expression assignment: `const Foo = (...) =>` / `= function`.
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/g)) add(m[1]);
  // JSX/Vue component tags (capitalized) and HTML/element ids.
  for (const m of code.matchAll(/<([A-Z][\w.]*)\b/g)) add(m[1]);
  for (const m of code.matchAll(/\bid=["']([\w-]+)["']/g)) add(m[1]);
  // CSS class-selector rule names.
  for (const m of code.matchAll(/\.([A-Za-z_-][\w-]{2,})\s*\{/g)) add(m[1]);
  // Relative import/require specifiers — the last path segment is often the
  // sibling file's own name (e.g. importing "./UserCard" from its test file).
  for (const m of code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g)) {
    const spec = m[1] || m[2];
    if (spec && spec.startsWith('.')) add(spec.split('/').pop().replace(/\.\w+$/, ''));
  }
  // Route/URL-ish strings (Express/Django paths, Next.js api routes).
  for (const m of code.matchAll(/['"](\/[a-zA-Z0-9_\-/]{2,})['"]/g)) add(m[1]);

  return [...ids].slice(0, 12);
}

// A CSS class/id almost always ALSO appears in the markup that uses it, so a
// pasted CSS rule routinely ties 1-1 between the real .css file and an .html
// file that merely references the class — plain match-count grep can't break
// that tie. This infers the snippet's OWN language and returns the file
// extensions it natively belongs in, so a tie resolves to the file whose
// type actually matches instead of being left ambiguous.
function inferPreferredExtensions(code) {
  const t = code || '';
  if (/[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^{}]*[\w-]+\s*:\s*[^;{}]+;/.test(t)) return ['.css', '.scss', '.sass', '.less'];
  if (/<\/?(div|span|section|header|footer|nav|main|body|html|ul|li|a|form|input|button|p|img)\b/i.test(t)) return ['.html', '.htm', '.vue', '.svelte'];
  if (/\bdef\s+\w+\(.*\)\s*:/.test(t) || (/^\s*import\s+\w+/.test(t) && !/[{};]/.test(t))) return ['.py'];
  if (/\binterface\s+\w+|:\s*(string|number|boolean)\b/.test(t)) return ['.ts', '.tsx'];
  if (/\bconst\b|\blet\b|\bfunction\b|=>/.test(t)) return ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'];
  return null;
}

// Rough cue that a snippet bundles multiple files' worth of code (component +
// stylesheet + test, etc.) — gates the deterministic grep fast-path below,
// since splitting still needs the AI even when grep finds a strong match.
function looksMultiFile(code) {
  const fenceLangs = new Set([...code.matchAll(/```([a-zA-Z0-9+#.\-]*)/g)].map(m => m[1].toLowerCase()).filter(Boolean));
  if (fenceLangs.size > 1) return true;
  if (/^\s*(?:\/\/|#)\s*(?:file|filename)\s*:/im.test(code)) return true;
  if ((code.match(/```/g) || []).length >= 4) return true;   // 2+ fenced blocks
  return false;
}

// ── Content grep (agent-harness-style: search first, guess second) ───────────
// Scans the project's text files for the extracted identifiers and ranks
// files by how many DISTINCT identifiers each contains. A file matching
// several of the snippet's own symbol names is far stronger evidence than
// naming conventions or folder structure alone.
function grepIdentifiers(root, identifiers, { maxFiles = 2000, maxFileBytes = 300 * 1024 } = {}) {
  if (!identifiers.length) return [];
  const hits = new Map();   // relPath -> { matched: Set, sample }
  let scanned = 0;

  const walk = (dir, rel) => {
    if (scanned >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (scanned >= maxFiles) return;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(path.join(dir, ent.name), relPath);
        continue;
      }
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      const full = path.join(dir, ent.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > maxFileBytes) continue;
      scanned++;
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const matched = new Set();
      let sample = null;
      for (const id of identifiers) {
        if (!content.includes(id)) continue;
        matched.add(id);
        if (!sample) {
          const idx = content.indexOf(id);
          const lineNo = content.slice(0, idx).split('\n').length;
          const lineText = (content.split('\n')[lineNo - 1] || '').trim().slice(0, 100);
          sample = { ident: id, line: lineNo, text: lineText };
        }
      }
      if (matched.size) hits.set(relPath, { matched: [...matched], sample });
    }
  };
  walk(root, '');

  return [...hits.entries()]
    .map(([relPath, v]) => ({ path: relPath, matchCount: v.matched.length, matched: v.matched, sample: v.sample }))
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, 15);
}

// Framework-specific placement conventions injected into the detection prompt.
const FRAMEWORK_RULES = {
  'Laravel': 'Controllers → app/Http/Controllers, Models → app/Models, Blade views → resources/views (*.blade.php), routes → routes/web.php or routes/api.php, migrations → database/migrations, config → config/.',
  'Next.js': 'Pages → pages/ or app/ (App Router: page.tsx/layout.tsx per folder), components → components/ or src/components, API routes → pages/api/ or app/api/**/route.ts, styles → styles/ or *.module.css next to the component.',
  'Django': 'Per app: views → views.py, models → models.py, urls → urls.py, forms → forms.py, admin → admin.py, templates → templates/<app>/, settings → the project package settings.py.',
  'React': 'Components → src/components/, pages/screens → src/pages/, hooks → src/hooks/, styles co-located as .css/.module.css next to the component, tests as *.test.js next to the source.',
  'Vue': 'Components → src/components/ (*.vue), views → src/views/, router → src/router/, stores → src/stores or src/store.',
  'Express': 'Routes → routes/, controllers → controllers/, middleware → middleware/, models → models/, entry → app.js/server.js/index.js.',
  'Rails': 'Controllers → app/controllers, models → app/models, views → app/views, routes → config/routes.rb.',
  'Svelte': 'Routes → src/routes (SvelteKit +page.svelte), components → src/lib/components.',
  'Angular': 'Components/services under src/app/**, one folder per component with .ts/.html/.css triplet.',
};

// ── AI detection ──────────────────────────────────────────────────────────────

/**
 * Ask Groq which file(s) the snippet belongs to.
 * Returns { success, files:[{path, confidence:'high'|'medium'|'low', reason,
 *           isNew, snippetPart}], multiFile, framework, cached, error }
 * `snippetPart` is set when the clipboard contains several files' worth of
 * code (e.g. component + CSS + test) — the sub-snippet destined for that file.
 */
async function detectTargetFiles(code) {
  const root = store.getRoot();
  if (!root) return { success: false, error: 'No project folder is being watched.' };

  const frameworks = detectFrameworks(root);
  const framework = primaryFramework(frameworks);

  // ── Explicit mention wins outright ───────────────────────────────────────
  // If the user plainly named a real file in the project, that beats any
  // amount of grep/AI guessing — no ambiguity, no API call needed.
  const hint = extractFileHint(code, root);
  if (hint) {
    const absPath = path.join(root, hint.path);
    if (!path.relative(root, absPath).startsWith('..')) {
      return {
        success: true,
        files: [{
          path: hint.path, absPath, confidence: 'high', isNew: false, snippetPart: null,
          reason: `You mentioned "${hint.mentioned}", targeting that file directly.`,
        }],
        multiFile: false, framework, tokensUsed: 0, hinted: true,
      };
    }
  }

  // ── Grep-first pass ──────────────────────────────────────────────────────
  // Mirrors how a coding-agent harness locates a file: search for the
  // snippet's own symbol names before reasoning about paths. An unambiguous
  // hit skips the AI call entirely — deterministic, instant, and exact.
  const identifiers = extractIdentifiers(code);
  const grepHits = identifiers.length ? grepIdentifiers(root, identifiers) : [];
  const multiFileLikely = looksMultiFile(code);

  // A tie between the snippet's own file type (e.g. .css) and an unrelated
  // one that merely references the same identifier (e.g. .html using the
  // class) should resolve to the native type, not stay ambiguous.
  const preferredExts = inferPreferredExtensions(code);
  const isPreferred = (relPath) => !!preferredExts && preferredExts.includes(path.extname(relPath).toLowerCase());
  if (preferredExts && grepHits.length > 1) {
    grepHits.sort((a, b) => {
      const aPref = isPreferred(a.path), bPref = isPreferred(b.path);
      if (aPref !== bPref) return aPref ? -1 : 1;
      return b.matchCount - a.matchCount;
    });
  }

  if (!multiFileLikely && grepHits.length) {
    const [top, second] = grepHits;
    const extBreaksTie = !!second && isPreferred(top.path) && !isPreferred(second.path);
    const unique = !second || top.matchCount > second.matchCount || extBreaksTie;
    if (unique && (top.matchCount >= 2 || grepHits.length === 1 || extBreaksTie)) {
      const absPath = path.join(root, top.path);
      if (!path.relative(root, absPath).startsWith('..')) {
        return {
          success: true,
          files: [{
            path: top.path, absPath, confidence: 'high', isNew: false, snippetPart: null,
            reason: `Matched ${top.matchCount} identifier(s) from the snippet (${top.matched.slice(0, 3).join(', ')})${extBreaksTie ? `, the only .${path.extname(top.path).slice(1)} match` : ', the only file that does'}.`,
          }],
          multiFile: false, framework, tokensUsed: 0, grepMatched: true,
        };
      }
    }
  }

  const tree = buildFileTree(root);
  const treeText = tree.join('\n');

  const fwLines = Object.entries(frameworks)
    .map(([d, fw]) => (d === '.' ? `Project framework: ${fw}` : `Sub-project "${d}/": ${fw}`))
    .join('\n') || 'No framework detected — match by file extension and naming only.';
  const rules = framework && FRAMEWORK_RULES[framework] ? `\nFramework conventions: ${FRAMEWORK_RULES[framework]}` : '';

  // Grep evidence — real file contents that already match the snippet's own
  // identifiers — grounds the model's answer instead of letting it guess
  // purely from file/folder naming.
  const grepSection = grepHits.length
    ? '\n\nGREP EVIDENCE (files whose content already matches identifiers from the snippet, ranked — treat a multi-identifier match as strong signal even if the filename looks unrelated):\n' +
      grepHits.slice(0, 8).map(h => `${h.path} — matched: ${h.matched.join(', ')}${h.sample ? ` (line ${h.sample.line}: ${h.sample.text})` : ''}`).join('\n')
    : '';

  const systemPrompt = `You are a code-placement engine. Given a copied CODE snippet and a project's FILE TREE, identify which existing file(s) the code belongs to — or the file that should be created for it.

${fwLines}${rules}

Rules:
- Use language/extension hints, identifiers, imports, framework conventions and folder structure.
- If GREP EVIDENCE is provided below, weigh it heavily — a file that already contains several of the snippet's own identifiers is very likely the right target.
- If the snippet clearly contains MULTIPLE files' worth of code (e.g. a component plus its stylesheet plus a test), split it: one entry per target file, each with "snippetPart" holding ONLY that file's portion of the snippet (verbatim, no fences).
- Entries in the tree ending with "/…" are unexpanded folders. If the right file is likely inside one, either request expansion by listing that folder path in "expandDirs" (and return no files), or guess the most likely full path with confidence "low".
- If no existing file fits but the code plainly belongs in a NEW file, return it with "isNew": true and a conventional path for this framework.
- Confidence: "high" = certain single match; "medium" = probable but worth confirming; "low" = a guess.
- Return at most 3 candidates per portion of code, best first.
- Return ONLY valid JSON:
{
  "files": [ { "path": "relative/path/from/project/root", "confidence": "high|medium|low", "reason": "<short>", "isNew": false, "snippetPart": "<omit unless the snippet spans multiple files>" } ],
  "expandDirs": ["optional/folder"],
  "multiFile": false
}`;

  // File tree first (large, stable across many detection calls in the same
  // project), snippet + grep evidence last (small, different every call) —
  // Groq's automatic prompt caching only reuses a matching PREFIX, so this
  // order lets repeated detections in the same project reuse the cached
  // tree tokens even though each pasted snippet is different.
  const userPrompt = `FILE TREE (relative to project root):\n${treeText}\n\nCODE SNIPPET:\n\`\`\`\n${code}\n\`\`\`${grepSection}`;

  // Detection responses are cached too (Task 3 ↔ Task 4 integration).
  // Key = tree + framework context + grep evidence + snippet, so a changed
  // project (or newly matching file) re-detects instead of reusing a stale answer.
  const cacheBasis = treeText + '\n' + fwLines + grepSection;
  const cached = store.cacheGet(cacheBasis, 'detect:' + code);
  if (cached) return { ...cached, cached: true };

  const ask = async (sys, usr) => groq.chatJson([
    { role: 'system', content: sys },
    { role: 'user', content: usr },
  ]);

  let r = await ask(systemPrompt, userPrompt);
  if (!r.success) return { success: false, error: r.error };
  let json = r.json || {};
  let usage = (r.usage && r.usage.total_tokens) || 0;

  // Very large projects: the model may ask to expand specific folders — one
  // deeper pass only, so detection stays fast on 1000+ file repos.
  if ((!json.files || !json.files.length) && Array.isArray(json.expandDirs) && json.expandDirs.length) {
    const deepTree = buildFileTree(root, { maxDepth: 3, deepDirs: json.expandDirs.slice(0, 5) });
    r = await ask(systemPrompt, `FILE TREE (expanded):\n${deepTree.join('\n')}\n\nCODE SNIPPET:\n\`\`\`\n${code}\n\`\`\``);
    if (!r.success) return { success: false, error: r.error };
    json = r.json || {};
    usage += (r.usage && r.usage.total_tokens) || 0;
  }

  const norm = (Array.isArray(json.files) ? json.files : [])
    .filter(f => f && typeof f.path === 'string' && f.path.trim())
    .slice(0, 6)
    .map(f => {
      const relPath = f.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/…$/, '');
      const abs = path.join(root, relPath);
      const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      return {
        path: relPath,
        absPath: abs,
        confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'low',
        reason: String(f.reason || '').slice(0, 200),
        isNew: !exists,
        snippetPart: typeof f.snippetPart === 'string' && f.snippetPart.trim() ? f.snippetPart : null,
      };
    })
    // Safety: results must stay inside the project.
    .filter(f => !path.relative(root, f.absPath).startsWith('..'));

  const result = {
    success: true,
    files: norm,
    multiFile: !!json.multiFile && norm.filter(f => f.snippetPart).length > 1,
    framework,
    tokensUsed: usage,
  };
  store.cacheSet(cacheBasis, 'detect:' + code, result, '');
  return result;
}

// ── Smart merge ───────────────────────────────────────────────────────────────

/**
 * Merge new code into an existing file's content via Groq — surgical, keeps
 * imports/comments/untouched functions. Cached on (fileContent + newCode).
 * Returns { success, merged, conflict, reason, cached, error }.
 */
async function smartMerge(filePath, fileContent, newCode) {
  const prompt = 'merge:' + newCode;
  const cached = store.cacheGet(fileContent, prompt);
  if (cached) return { ...cached, cached: true };

  const systemPrompt = `You are a precise code merger. You receive the CURRENT contents of a file and a NEW code snippet that belongs in that file. Produce the complete merged file.

Rules:
- Insert or replace ONLY the sections the new code affects. If the snippet is an updated version of an existing function/component/element, replace that block in place.
- Preserve all existing imports, functions, comments and formatting that the new code does not touch. Merge import lists instead of duplicating them.
- Match the file's existing indentation and style.
- Never truncate; return the ENTIRE file. No placeholders like "... rest unchanged".
- If the new code fundamentally contradicts existing code and you cannot merge safely, set "conflict": true and explain in "reason"; still return your best merged attempt in "content".
- Return ONLY valid JSON: { "content": "<entire merged file>", "conflict": false, "reason": "<one sentence>" }`;

  const r = await groq.chatJson([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `FILE (${path.basename(filePath)}):\n\`\`\`\n${fileContent}\n\`\`\`\n\nNEW CODE:\n\`\`\`\n${newCode}\n\`\`\`` },
  ]);
  if (!r.success) return { success: false, error: r.error };
  const json = r.json || {};
  if (typeof json.content !== 'string' || !json.content.trim()) {
    return { success: false, error: 'AI did not return merged content.' };
  }
  const result = {
    success: true,
    merged: json.content,
    conflict: !!json.conflict,
    reason: String(json.reason || '').slice(0, 200),
    tokensUsed: (r.usage && r.usage.total_tokens) || 0,
  };
  store.cacheSet(fileContent, prompt, result, filePath);
  return result;
}

module.exports = {
  detectFrameworks, primaryFramework, detectTargetFiles, smartMerge, buildFileTree,
  extractIdentifiers, grepIdentifiers, looksMultiFile, extractFileHint, inferPreferredExtensions,
};
