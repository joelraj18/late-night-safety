// End-to-end test in real Chromium with the real face tracker.
//
// The camera is replaced by a canvas stream that shows a real face photo
// (tests/e2e/fixtures) with eyes open or painted shut, on a schedule chosen
// by the test. It checks, against the live app:
//   - the start checklist (permissions popup) and monitoring start
//   - a normal blink does NOT sound the alarm
//   - eyes shut ~1 s DOES sound it, for 3 s, and the sound engine is playing
//   - darkness turns on the white night light, which lets the face be seen
//   - the drive summary shows the alarm
//   - everything above also works after going offline
//
// Usage: npm run test:e2e        (needs the playwright package + Chromium)
//        SCREENSHOTS=dir npm run test:e2e   to save screenshots
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const fixture = (name) => `data:image/jpeg;base64,${readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64')}`;

const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
await new Promise((resolve) => server.stdout.once('data', resolve));

let failures = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}

function fakeCamera({ open, closed }) {
  // Runs inside the page before the app loads.
  const images = {};
  for (const [k, url] of Object.entries({ open, closed })) {
    images[k] = new Image();
    images[k].src = url;
  }
  const marks = [];
  window.__marks = marks;
  window.__fakeCam = { mode: 'open' };
  const watch = () => {
    new MutationObserver((records) => {
      for (const r of records) marks.push({ attr: r.attributeName, value: document.documentElement.getAttribute(r.attributeName), t: performance.now() });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-alarm', 'data-light', 'data-level', 'data-phase'] });
  };
  if (document.documentElement) watch();
  else document.addEventListener('readystatechange', watch, { once: true });
  navigator.mediaDevices.getUserMedia = async () => {
    const W = 640;
    const H = 480;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      let mode = window.__fakeCam.mode;
      let brightness = 1;
      if (mode === 'dark') {
        // Night: the face is almost invisible... until the white screen lights it up.
        mode = 'open';
        brightness = document.documentElement.dataset.light === 'on' ? 0.9 : 0.06;
      }
      if (mode === 'away') {
        ctx.fillStyle = '#5a6070';
        ctx.fillRect(0, 0, W, H);
      } else {
        ctx.filter = `brightness(${brightness})`;
        ctx.drawImage(images[mode], 0, 0, W, H);
        ctx.filter = 'none';
      }
      // A little sensor noise, like a real camera.
      ctx.fillStyle = `rgba(${(Math.random() * 255) | 0}, 128, 128, 0.05)`;
      ctx.fillRect((Math.random() * W) | 0, (Math.random() * H) | 0, 12, 12);
    };
    draw();
    setInterval(draw, 33);
    return canvas.captureStream(30);
  };
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

async function newPhonePage() {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  await context.addInitScript(fakeCamera, { open: fixture('face-open.jpg'), closed: fixture('face-closed.jpg') });
  const page = await context.newPage();
  const errors = [];
  collectErrors(page, errors);
  return { context, page, errors };
}

// MediaPipe prints its own INFO/W0000 log lines through console.error; those are not app errors.
const MEDIAPIPE_LOG = /^(INFO:|[IWE]\d{4} |W0000|I0000|Graph successfully)/;
function collectErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !MEDIAPIPE_LOG.test(m.text()) && errors.push(m.text()));
}

const setMode = (page, mode) => page.evaluate((m) => ((window.__fakeCam.mode = m), performance.now()), mode);
const markAfter = (page, attr, value, after, timeout = 8000) =>
  page
    .waitForFunction(
      ([a, v, t]) => window.__marks.find((m) => m.attr === a && m.value === v && m.t > t),
      [attr, value, after],
      { timeout },
    )
    .then((h) => h.jsonValue());

async function startMonitoring(page) {
  await page.click('#start-btn');
  await page.waitForSelector('#perm-dialog[open]');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-permissions.png` });
  await page.click('#perm-allow');
  await page.waitForFunction(() => document.documentElement.dataset.phase === 'monitoring', null, { timeout: 60000 });
}

async function driveScenario(page, label) {
  await check(`${label}: normal blink is ignored`, async () => {
    await page.waitForTimeout(1500);
    const t = await setMode(page, 'closed');
    await page.waitForTimeout(250);
    await setMode(page, 'open');
    await page.waitForTimeout(2500);
    const alarms = await page.evaluate((t0) => window.__marks.filter((m) => m.attr === 'data-alarm' && m.value === 'on' && m.t > t0).length, t);
    assert.equal(alarms, 0, 'alarm sounded for a 250 ms blink');
  });

  await check(`${label}: eyes shut for 1 s sound a 3 s alarm`, async () => {
    const t = await setMode(page, 'closed');
    const on = await markAfter(page, 'data-alarm', 'on', t);
    const delay = on.t - t;
    assert.ok(delay >= 950 && delay < 2200, `alarm after ${Math.round(delay)} ms (want ~1000)`);
    console.log(`     eyes shut -> alarm after ${Math.round(delay)} ms`);
    const sound = await page.evaluate(() => ({ playing: window.__lns.alarm.playing, state: window.__lns.alarm.ctx?.state }));
    assert.equal(sound.playing, true, 'alarm sound graph not playing');
    assert.equal(sound.state, 'running', `audio context ${sound.state}`);
    if (SHOTS && label === 'online') await page.screenshot({ path: `${SHOTS}/3-alarm.png` });
    await setMode(page, 'open');
    const off = await markAfter(page, 'data-alarm', 'off', on.t, 8000);
    const length = off.t - on.t;
    assert.ok(length >= 2900 && length < 3800, `alarm lasted ${Math.round(length)} ms (want 3000)`);
    console.log(`     alarm lasted ${Math.round(length)} ms`);
  });

  await check(`${label}: darkness turns on the white night light, and the face is found again`, async () => {
    await page.waitForTimeout(1000);
    const t = await setMode(page, 'dark');
    const on = await markAfter(page, 'data-light', 'on', t, 8000);
    assert.ok(on.t - t < 4000, `night light after ${Math.round(on.t - t)} ms`);
    console.log(`     dark -> white night light after ${Math.round(on.t - t)} ms`);
    await page.waitForFunction(() => document.getElementById('status-label').textContent === 'Active', null, { timeout: 8000 });
    if (SHOTS && label === 'online') await page.screenshot({ path: `${SHOTS}/4-night-light.png` });
  });

  await check(`${label}: stop shows the drive summary with the alarm`, async () => {
    await page.click('#nl-stop');
    await page.waitForSelector('#summary-dialog[open]');
    const kpis = await page.$$eval('#summary-kpis .kpi', (nodes) => Object.fromEntries(nodes.map((n) => [n.children[0].textContent, n.children[1].textContent])));
    assert.equal(kpis['Sleep alarms'], '1', JSON.stringify(kpis));
    const rows = await page.$$eval('#summary-table tr', (r) => r.length);
    assert.ok(rows >= 1, 'summary table is empty');
    if (SHOTS && label === 'online') {
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/5-summary.png` });
    }
  });
}

try {
  // ---------------- online run (also saves the app for offline use)
  const { context, page, errors } = await newPhonePage();
  await page.goto(`${BASE}?debug`);
  await check('app saves itself for offline use', async () => {
    await page.waitForFunction(() => document.getElementById('offline-chip').dataset.state === 'ready', null, { timeout: 60000 });
  });
  await check('start checklist → monitoring (camera, keep-awake, sound)', async () => {
    await startMonitoring(page);
    const states = await page.$$eval('.perm-list li', (lis) => lis.map((li) => `${li.dataset.perm}:${li.dataset.state}`));
    assert.ok(states.includes('camera:granted'), states.join(' '));
    assert.ok(states.includes('sound:granted'), states.join(' '));
    console.log(`     checklist: ${states.join(', ')}`);
    console.log(`     tracker: ${await page.evaluate(() => window.__lns.run.detector.delegate)}`);
  });
  if (SHOTS) {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/2-monitoring.png` });
  }
  await driveScenario(page, 'online');
  await check('no errors in the page', async () => assert.deepEqual(errors, []));

  // ---------------- offline run: reload with the network off
  await context.setOffline(true);
  const page2 = await context.newPage();
  const errors2 = [];
  collectErrors(page2, errors2);
  await check('offline: app opens with no internet', async () => {
    await page2.goto(`${BASE}?debug`);
    await page2.waitForSelector('#start-btn');
  });
  await check('offline: face tracker loads and monitoring starts', async () => {
    await startMonitoring(page2);
  });
  await driveScenario(page2, 'offline');
  await check('offline: no errors in the page', async () => assert.deepEqual(errors2, []));
  await context.close();

  // ---------------- laptop layout screenshot while monitoring
  if (SHOTS) {
    const laptop = await browser.newContext({ viewport: { width: 1280, height: 760 } });
    await laptop.addInitScript(fakeCamera, { open: fixture('face-open.jpg'), closed: fixture('face-closed.jpg') });
    const p = await laptop.newPage();
    await p.goto(`${BASE}?debug`);
    await p.click('#start-btn');
    await p.click('#perm-allow');
    await p.waitForFunction(() => document.documentElement.dataset.phase === 'monitoring', null, { timeout: 60000 });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `${SHOTS}/6-laptop.png` });
    await laptop.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall end-to-end checks passed');
process.exit(failures ? 1 : 0);
