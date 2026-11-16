// The app must work offline, so every file it loads has to be in the service
// worker's precache list. This catches "added a file, forgot sw.js".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const assets = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

function filesUnder(dir, keep = () => true) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) out.push(...filesUnder(rel, keep));
    else if (keep(rel)) out.push(relative(root, join(root, rel)).split('\\').join('/'));
  }
  return out;
}

test('every precached file exists', () => {
  for (const a of assets) assert.ok(existsSync(join(root, a)), `${a} is listed in sw.js but missing`);
});

test('every app file is precached for offline use', () => {
  const needed = [
    'index.html',
    'manifest.webmanifest',
    ...filesUnder('js', (f) => f.endsWith('.js')),
    ...filesUnder('css', (f) => f.endsWith('.css')),
    ...filesUnder('icons', (f) => /\.(png|svg)$/.test(f)),
    ...filesUnder('vendor', (f) => /\.(js|wasm|task)$/.test(f)),
  ];
  const missing = needed.filter((f) => !assets.includes(f));
  assert.deepEqual(missing, [], `add these to ASSETS in sw.js: ${missing.join(', ')}`);
});

test('the page only loads local files (no CDN), so it can run offline', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)="https?:\/\//, 'no external scripts/styles/images');
  for (const f of filesUnder('js', (x) => x.endsWith('.js'))) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(src, /\bimport\s*\(?\s*['"]https?:/, `${f} imports from the network`);
    assert.doesNotMatch(src, /fetch\(\s*['"]https?:/, `${f} fetches from the network`);
  }
});
