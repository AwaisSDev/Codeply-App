#!/usr/bin/env node
/**
 * Build the UI hot-update (OTA) bundle.
 *
 * Packs the UI-only files (HTML/CSS/JS + referenced assets) into a single
 * `ui-bundle.json`, and writes a small `ui-manifest.json` that the running app
 * polls. Bump `uiVersion` in `ui-version.json` before running, then commit +
 * push both generated files to the repo's main branch — installed apps pick up
 * the change live, no reinstall.
 *
 * Usage:  node scripts/build-ui-bundle.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// Folders / files that make up the swappable UI layer. Anything the renderer
// references via relative paths must be here so the OTA copy is self-contained.
// NOTE: main.js and preload.js are the NATIVE layer — never include them.
const UI_PATHS = ['tokens.css', 'Dashboard', 'Renderer', 'logos', 'assets'];

function walk(abs, rel, out) {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      walk(path.join(abs, name), rel ? `${rel}/${name}` : name, out);
    }
  } else {
    out[rel] = fs.readFileSync(abs).toString('base64');
  }
}

function main() {
  const verInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui-version.json'), 'utf8'));
  const uiVersion = Number(verInfo.uiVersion) || 0;
  const minAppVersion = verInfo.minAppVersion || '0.0.0';

  const files = {};
  for (const p of UI_PATHS) {
    const abs = path.join(ROOT, p);
    if (!fs.existsSync(abs)) { console.warn('  (skip, not found)', p); continue; }
    walk(abs, p, files);
  }

  // ── ui-bundle.json (the payload the app downloads) ──
  const bundle = { uiVersion, minAppVersion, files };
  const bundleStr = JSON.stringify(bundle);
  fs.writeFileSync(path.join(ROOT, 'ui-bundle.json'), bundleStr);
  const sha256 = crypto.createHash('sha256').update(Buffer.from(bundleStr)).digest('hex');

  // ── ui-manifest.json (small file the app polls) ──
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pub = (pkg.build && pkg.build.publish) || {};
  const owner = pub.owner || 'AwaissDev';
  const repo = pub.repo || 'Codeply-App';
  const branch = 'main';
  const bundleUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/ui-bundle.json`;

  const manifest = { uiVersion, minAppVersion, bundleUrl, sha256 };
  fs.writeFileSync(path.join(ROOT, 'ui-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const kb = (Buffer.byteLength(bundleStr) / 1024).toFixed(0);
  console.log(`✓ UI bundle built — version ${uiVersion}, ${Object.keys(files).length} files, ${kb} KB`);
  console.log(`  sha256: ${sha256}`);
  console.log(`  Next: git add ui-version.json ui-bundle.json ui-manifest.json && git commit -m "ui: v${uiVersion}" && git push`);
}

main();
