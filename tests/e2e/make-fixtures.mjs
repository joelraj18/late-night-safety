// Builds the face images used by the end-to-end test:
//   fixtures/face-open.jpg   - a real face, eyes open
//   fixtures/face-closed.jpg - the same face with the eyes painted shut
// Source photo: NASA portrait of astronaut Eileen Collins (public domain),
// as shipped in scikit-image's sample data (skimage/data/astronaut.png).
//
// Usage: node tests/e2e/make-fixtures.mjs path/to/astronaut.png
// (needs the dev server running: npm start)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const src = process.argv[2];
const base = process.env.BASE_URL || 'http://localhost:8080/';
const outDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'load' });
const dataUrl = `data:image/png;base64,${readFileSync(src).toString('base64')}`;

const result = await page.evaluate(async (dataUrl) => {
  const { createDetector, OUTLINES } = await import('./js/detector.js');
  const { computeFaceMetrics } = await import('./js/drowsiness.js');
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  // Crop around the face and scale to a 640x480 "phone camera" frame.
  const W = 640;
  const H = 480;
  const open = document.createElement('canvas');
  open.width = W;
  open.height = H;
  const octx = open.getContext('2d');
  octx.drawImage(img, 72, 10, 300, 225, 0, 0, W, H);

  const detector = await createDetector({ useGPU: false });
  let t = 1000;
  const run = (canvas) => {
    let res;
    for (let i = 0; i < 3; i++) res = detector.detect(canvas, (t += 100));
    return res;
  };
  const r1 = run(open);
  const lm = r1.faceLandmarks[0];
  if (!lm) throw new Error('no face found in the open-eyes image');

  const closed = document.createElement('canvas');
  closed.width = W;
  closed.height = H;
  const cctx = closed.getContext('2d');
  cctx.drawImage(open, 0, 0);
  const P = (i) => [lm[i].x * W, lm[i].y * H];
  const avgColor = (x, y, w, h) => {
    const d = octx.getImageData(Math.round(x), Math.round(y), Math.max(2, Math.round(w)), Math.max(2, Math.round(h))).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    return [r / n, g / n, b / n];
  };
  for (const name of ['rightEye', 'leftEye']) {
    const ids = OUTLINES[name];
    const pts = ids.map(P);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const eyeW = maxX - minX;
    const eyeH = maxY - minY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Eyelid skin tone: blend of the skin just above and just below the eye.
    const above = avgColor(minX + eyeW * 0.2, minY - eyeH * 0.75, eyeW * 0.6, eyeH * 0.35);
    const below = avgColor(minX + eyeW * 0.2, maxY + eyeH * 0.45, eyeW * 0.6, eyeH * 0.4);
    const skin = above.map((v, i) => (v * 0.45 + below[i] * 0.55) * 0.97);
    const rgb = (c, a = 1) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
    // Soft-edged eyelid patch, a bit bigger than the eye so no dark lid line survives.
    const patch = document.createElement('canvas');
    patch.width = W;
    patch.height = H;
    const p = patch.getContext('2d');
    const grad = p.createLinearGradient(0, minY - eyeH * 0.6, 0, maxY + eyeH * 0.5);
    grad.addColorStop(0, rgb(above.map((v) => v * 0.97)));
    grad.addColorStop(0.55, rgb(skin.map((v) => v * 0.93)));
    grad.addColorStop(1, rgb(below));
    p.fillStyle = grad;
    p.beginPath();
    p.ellipse(cx, cy, eyeW * 0.66, eyeH * 1.15, 0, 0, Math.PI * 2);
    p.fill();
    cctx.save();
    cctx.filter = `blur(${Math.max(1.5, eyeH * 0.25)}px)`;
    cctx.drawImage(patch, 0, 0);
    cctx.restore();
    cctx.save();
    cctx.beginPath();
    cctx.ellipse(cx, cy, eyeW * 0.6, eyeH * 0.95, 0, 0, Math.PI * 2);
    cctx.clip();
    cctx.drawImage(patch, 0, 0);
    cctx.restore();
    // Closed-lid lash line: a gentle downward curve across the eye, plus short lashes.
    const inner = name === 'rightEye' ? P(133) : P(362);
    const outer = name === 'rightEye' ? P(33) : P(263);
    const midY = cy + eyeH * 0.25;
    cctx.save();
    cctx.strokeStyle = 'rgba(55, 35, 28, 0.85)';
    cctx.lineCap = 'round';
    cctx.lineWidth = Math.max(1.5, eyeH * 0.16);
    cctx.beginPath();
    cctx.moveTo(inner[0], inner[1] + eyeH * 0.1);
    cctx.quadraticCurveTo(cx, midY + eyeH * 0.35, outer[0], outer[1] + eyeH * 0.05);
    cctx.stroke();
    cctx.lineWidth = Math.max(1, eyeH * 0.08);
    for (let k = 1; k < 8; k++) {
      const tt = k / 8;
      const x = (1 - tt) * (1 - tt) * inner[0] + 2 * (1 - tt) * tt * cx + tt * tt * outer[0];
      const y = (1 - tt) * (1 - tt) * (inner[1] + eyeH * 0.1) + 2 * (1 - tt) * tt * (midY + eyeH * 0.35) + tt * tt * (outer[1] + eyeH * 0.05);
      cctx.beginPath();
      cctx.moveTo(x, y);
      cctx.lineTo(x + (outer[0] > inner[0] ? 1 : -1) * eyeH * 0.12, y + eyeH * 0.22);
      cctx.stroke();
    }
    cctx.restore();
  }
  const r2 = run(closed);
  const mOpen = computeFaceMetrics(r1, W, H);
  const mClosed = computeFaceMetrics(r2, W, H);
  detector.close();
  return {
    open: open.toDataURL('image/jpeg', 0.9),
    closed: closed.toDataURL('image/jpeg', 0.9),
    mOpen,
    mClosed,
  };
}, dataUrl);

for (const name of ['open', 'closed']) {
  writeFileSync(`${outDir}face-${name}.jpg`, Buffer.from(result[name].split(',')[1], 'base64'));
}
const fmt = (m) => m && `EAR ${m.ear.toFixed(3)} blink ${m.blink.toFixed(2)} jaw ${m.jawOpen.toFixed(2)}`;
console.log('open  :', fmt(result.mOpen));
console.log('closed:', fmt(result.mClosed));
await browser.close();
