// Copies the web app into www/ for the Android app (Capacitor) and for
// GitHub Pages. The app has no build step: these are the same files you
// open in the browser.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'www');
const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'vendor'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of files) cpSync(join(root, f), join(out, f), { recursive: true });
// GitHub Pages: serve files as-is (no Jekyll processing).
cpSync(join(root, '.nojekyll'), join(out, '.nojekyll'));
console.log(`Web app copied to ${out}`);
