// Late Night Safety: main controller. Wires the camera, face tracker,
// drowsiness logic, alarm, night light, keep-screen-on and offline support
// to the page.

import { AlarmSound } from './alarm.js';
import { listCameras, openCamera, stopStream } from './camera.js';
import { SessionChart } from './chart.js';
import { OUTLINES, createDetector } from './detector.js';
import { Calibrator, DrowsinessMonitor, SENSITIVITY, computeFaceMetrics } from './drowsiness.js';
import { isNativeApp, isStandalone, platformName } from './native.js';
import { NightLightController } from './night-light.js';
import { setupPwa } from './pwa.js';
import { ScreenAwake } from './screen-awake.js';
import { EVENT_LABELS, SessionLog, formatClock } from './session-log.js';
import { DEFAULTS, loadSettings, sanitize, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const params = new URLSearchParams(location.search);
const PLATFORM = platformName(); // android-app | android | ios | desktop
const MOBILE = PLATFORM !== 'desktop';
const MIN_FRAME_MS = 1000 / 24; // ~24 fps is plenty, and kinder to battery and heat
const LUMA_EVERY_MS = 300;

const el = {
  home: $('home'),
  monitor: $('monitor'),
  start: $('start-btn'),
  homeClosed: $('home-closed'),
  homeAlarm: $('home-alarm'),
  platformHint: $('platform-hint'),
  offlineChip: $('offline-chip'),
  updateBtn: $('update-btn'),
  installBtn: $('install-btn'),
  settingsBtn: $('settings-btn'),
  video: $('video'),
  overlay: $('overlay'),
  calibration: $('calibration'),
  calibrationRing: document.querySelector('.calibration-ring'),
  calibrationPct: $('calibration-pct'),
  calibrationText: $('calibration-text'),
  loading: $('loading'),
  loadingText: $('loading-text'),
  status: $('status'),
  statusLabel: $('status-label'),
  statusSub: $('status-sub'),
  srLive: $('sr-live'),
  meter: $('meter'),
  meterFill: $('meter-fill'),
  meterMark: $('meter-mark'),
  meterValue: $('meter-value'),
  statTime: $('stat-time'),
  statAlarms: $('stat-alarms'),
  statDrowsy: $('stat-drowsy'),
  statYawns: $('stat-yawns'),
  indScreen: $('ind-screen'),
  indSound: $('ind-sound'),
  indOffline: $('ind-offline'),
  breakBanner: $('break-banner'),
  fixBanner: $('fix-banner'),
  fixText: $('fix-text'),
  fixBtn: $('fix-btn'),
  stopBtn: $('stop-btn'),
  lightBtn: $('light-btn'),
  lightBtnText: $('light-btn-text'),
  recalBtn: $('recal-btn'),
  fullscreenBtn: $('fullscreen-btn'),
  details: $('details'),
  nightlight: $('nightlight'),
  nlText: $('nl-text'),
  nlOff: $('nl-off'),
  nlStop: $('nl-stop'),
  alarm: $('alarm'),
  alarmTitle: $('alarm-title'),
  alarmSub: $('alarm-sub'),
  toast: $('toast'),
  permDialog: $('perm-dialog'),
  permError: $('perm-error'),
  permSoundText: $('perm-sound-text'),
  permTest: $('perm-test'),
  permSkip: $('perm-skip'),
  permCancel: $('perm-cancel'),
  permAllow: $('perm-allow'),
  settingsDialog: $('settings-dialog'),
  settingsForm: $('settings-form'),
  settingsClose: $('settings-close'),
  testAlarm: $('test-alarm'),
  resetSettings: $('reset-settings'),
  summaryDialog: $('summary-dialog'),
  summaryClose: $('summary-close'),
  summaryKpis: $('summary-kpis'),
  summaryAdvice: $('summary-advice'),
  summaryLegend: $('summary-legend'),
  summaryChart: $('summary-chart'),
  summaryTable: $('summary-table'),
};

const settings = loadSettings();
const alarm = new AlarmSound();
const awake = new ScreenAwake();
const monitor = new DrowsinessMonitor();
const calibrator = new Calibrator();
const light = new NightLightController({ mode: settings.nightLight });

const run = {
  phase: 'idle', // idle | starting | calibrating | monitoring
  stream: null,
  detector: null,
  detectorLoading: null,
  recovering: false,
  log: null,
  startedAt: 0,
  lastFrameAt: 0,
  luma: null,
  lumaAt: 0,
  frameSig: null,
  frameSigSince: 0,
  frames: [],
  lastRenderAt: 0,
  lastLevel: null,
  snap: null,
  rafId: 0,
  ticker: null,
  hiddenAt: null,
  offline: { state: 'checking' },
  overlayDrawn: false,
  chart: null,
  toastTimer: null,
};

// ---------------------------------------------------------------- helpers

function setPhase(phase) {
  run.phase = phase;
  root.dataset.phase = phase;
}

function showScreen(name) {
  el.home.hidden = name !== 'home';
  el.monitor.hidden = name !== 'monitor';
}

function toast(text, kind = 'info', ms = 4000) {
  el.toast.textContent = text;
  el.toast.dataset.kind = kind;
  el.toast.hidden = false;
  clearTimeout(run.toastTimer);
  run.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

function seconds(n) {
  const v = Number(n);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} second${v === 1 ? '' : 's'}`;
}

function setIndicator(node, ok) {
  node.dataset.ok = ok === null ? 'unknown' : ok ? 'yes' : 'no';
}

const problems = new Map();
function setProblem(key, text, fix) {
  if (text && run.phase !== 'idle') problems.set(key, { text, fix });
  else problems.delete(key);
  const first = ['camera', 'sound', 'screen'].map((k) => problems.get(k)).find(Boolean);
  el.fixBanner.hidden = !first;
  if (first) {
    el.fixText.textContent = first.text;
    el.fixBtn.onclick = () => first.fix?.();
  }
}

function setPerm(name, state) {
  const li = el.permDialog.querySelector(`[data-perm="${name}"]`);
  if (li) li.dataset.state = state;
}

// ---------------------------------------------------------------- settings

function applySettings() {
  monitor.configure({
    closedMs: settings.closedSeconds * 1000,
    alarmMs: settings.alarmSeconds * 1000,
    sensitivity: settings.sensitivity,
    noFaceAlertMs: settings.noFaceAlertSeconds * 1000,
    yawnMs: settings.yawnDetection ? 1500 : Infinity,
  });
  alarm.volume = settings.volume;
  alarm.vibrate = settings.vibrate;
  alarm.silentModeOverride = settings.silentModeOverride;
  light.setMode(settings.nightLight);
  root.dataset.mirror = settings.mirror ? 'on' : 'off';
  root.dataset.preview = settings.showPreview ? 'on' : 'off';
  root.style.setProperty('--light-level', String(settings.lightLevel));
  el.details.hidden = !settings.showDetails || run.phase === 'idle';
  el.homeClosed.textContent = seconds(settings.closedSeconds);
  el.homeAlarm.textContent = seconds(settings.alarmSeconds);
  el.permSoundText.textContent = `A loud ${Number(settings.alarmSeconds)}-second buzz if your eyes stay closed. Turn your volume up.`;
  el.meterMark.style.left = `${SENSITIVITY[settings.sensitivity].close * 100}%`;
  if (run.phase !== 'idle') applyNightLight(light.on);
}

function fillSettingsForm() {
  const form = el.settingsForm;
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input instanceof RadioNodeList) input.value = String(value);
    else if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = String(value);
  }
  updateOutputs();
}

function updateOutputs() {
  const form = el.settingsForm;
  const text = {
    closedSeconds: `${Number(form.elements.closedSeconds.value).toFixed(1)} s`,
    alarmSeconds: `${form.elements.alarmSeconds.value} s`,
    volume: `${Math.round(Number(form.elements.volume.value) * 100)}%`,
  };
  for (const out of form.querySelectorAll('output[data-for]')) out.textContent = text[out.dataset.for] ?? '';
}

function readSettingsForm() {
  const form = el.settingsForm;
  const next = { ...settings };
  for (const key of Object.keys(DEFAULTS)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input instanceof RadioNodeList) next[key] = input.value;
    else if (input.type === 'checkbox') next[key] = input.checked;
    else if (typeof DEFAULTS[key] === 'number') next[key] = Number(input.value);
    else next[key] = input.value;
  }
  return sanitize(next);
}

function onSettingsChanged() {
  const before = { ...settings };
  Object.assign(settings, readSettingsForm());
  saveSettings(settings);
  applySettings();
  updateOutputs();
  if (run.phase !== 'idle' && before.cameraId !== settings.cameraId) restartCamera();
  if (before.useGPU !== settings.useGPU) {
    if (run.phase === 'idle') {
      run.detector?.close();
      run.detector = null;
      run.detectorLoading = null;
    } else {
      toast('The GPU setting applies the next time you press Start.');
    }
  }
  if (!before.showPreview && settings.showPreview) run.overlayDrawn = false;
}

async function openSettings() {
  fillSettingsForm();
  const select = el.settingsForm.elements.cameraId;
  const cams = await listCameras();
  select.replaceChildren(new Option('Front camera (default)', ''));
  cams.forEach((cam, i) => select.append(new Option(cam.label || `Camera ${i + 1}`, cam.deviceId)));
  select.value = settings.cameraId;
  if (select.value !== settings.cameraId) select.value = '';
  el.settingsDialog.showModal();
}

// ---------------------------------------------------------------- face tracker

function preloadDetector() {
  if (!run.detectorLoading) {
    const loading = createDetector({ useGPU: settings.useGPU && !params.has('cpu') })
      .then((detector) => {
        if (run.detectorLoading !== loading) {
          // Settings changed while it was loading: this one is no longer wanted.
          detector.close();
          throw new Error('The face tracker was reset. Press Start again.');
        }
        run.detector = detector;
        return detector;
      })
      .catch((err) => {
        if (run.detectorLoading === loading) run.detectorLoading = null;
        throw err;
      });
    run.detectorLoading = loading;
  }
  return run.detectorLoading;
}

async function recoverDetector() {
  if (run.recovering || !run.detector) return;
  run.recovering = true;
  try {
    if (await run.detector.switchToCpu()) toast('Switched face tracking to CPU mode.');
    else throw new Error('Face tracking stopped working.');
  } catch (err) {
    fatal(err);
  } finally {
    run.recovering = false;
  }
}

// ---------------------------------------------------------------- start / stop

function onStartTap() {
  preloadDetector().catch(() => {}); // start loading in the background right away
  if (settings.skipPermissionPopup) {
    beginMonitoring();
    return;
  }
  for (const name of ['camera', 'screen', 'sound']) setPerm(name, 'needed');
  el.permError.hidden = true;
  el.permSkip.checked = settings.skipPermissionPopup;
  el.permDialog.showModal();
}

/** Must be called from a tap: sound and keep-awake can only be unlocked by a user gesture. */
async function beginMonitoring() {
  if (run.phase !== 'idle') return;
  setPhase('starting');
  el.permAllow.disabled = true;

  // 1. Inside the tap.
  const soundOk = alarm.unlock();
  setPerm('sound', soundOk ? 'granted' : 'failed');
  setPerm('screen', 'asking');
  const awakeReady = awake.enable();
  navigator.storage?.persist?.().catch(() => {});

  // 2. Camera (the browser / Android shows its own permission prompt).
  setPerm('camera', 'asking');
  let stream;
  try {
    stream = await openCamera({ deviceId: settings.cameraId });
  } catch (err) {
    setPerm('camera', 'failed');
    el.permError.textContent = err.message;
    el.permError.hidden = false;
    if (!el.permDialog.open) el.permDialog.showModal();
    el.permAllow.disabled = false;
    await awake.disable();
    setPhase('idle');
    return;
  }
  setPerm('camera', 'granted');
  const screenOk = await Promise.race([awakeReady.catch(() => false), new Promise((r) => setTimeout(() => r(false), 2500))]);
  setPerm('screen', screenOk ? 'granted' : 'failed');
  el.permAllow.disabled = false;
  if (el.permDialog.open) {
    settings.skipPermissionPopup = el.permSkip.checked;
    saveSettings(settings);
    setTimeout(() => el.permDialog.open && el.permDialog.close(), screenOk ? 450 : 1200);
  }

  // 3. Monitoring screen.
  showScreen('monitor');
  if (!history.state?.lnsMonitoring) history.pushState({ lnsMonitoring: true }, '');
  el.fullscreenBtn.hidden = !(document.fullscreenEnabled && !isNativeApp());
  el.details.hidden = !settings.showDetails;
  setStatus('unknown', 'Starting…', 'Loading the face tracker');
  attachStream(stream);
  showLoading('Loading face tracker…');
  try {
    await preloadDetector();
  } catch (err) {
    fatal(err);
    return;
  }
  if (run.phase !== 'starting') return; // stopped meanwhile
  hideLoading();
  startSession();
}

function startSession() {
  const now = performance.now();
  monitor.reset();
  calibrator.reset();
  light.setMode(settings.nightLight);
  light.reset();
  applyNightLight(light.on);
  run.log = null; // created when calibration finishes, so the drive starts at 0:00
  run.startedAt = now;
  run.lastFrameAt = 0;
  run.luma = null;
  run.lastLevel = null;
  el.breakBanner.hidden = true;
  setPhase('calibrating');
  el.calibration.hidden = false;
  showCalibration(0, null);
  setIndicator(el.indScreen, awake.active);
  setIndicator(el.indSound, alarm.ctx ? !alarm.blocked : false);
  setIndicator(el.indOffline, run.offline.state === 'ready');
  startLoop();
}

async function stopMonitoring({ summary = true } = {}) {
  if (run.phase === 'idle') return;
  const hadSession = Boolean(run.log);
  setPhase('idle');
  stopLoop();
  alarm.stop();
  hideAlarm();
  stopStream(run.stream);
  run.stream = null;
  el.video.srcObject = null;
  light.reset();
  applyNightLight(false);
  await awake.disable();
  problems.clear();
  setProblem('camera', null);
  el.calibration.hidden = true;
  el.breakBanner.hidden = true;
  hideLoading();
  clearOverlay();
  showScreen('home');
  if (history.state?.lnsMonitoring) {
    run.ignorePop = true;
    history.back();
  }
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (summary && hadSession) {
    run.log.endT = performance.now();
    openSummary(run.log);
  }
}

function fatal(err) {
  console.error(err);
  const message = err?.message || String(err);
  stopMonitoring({ summary: false }).then(() => {
    toast(`Couldn't start: ${message}`, 'drowsy', 9000);
  });
}

function attachStream(stream) {
  run.stream = stream;
  el.video.srcObject = stream;
  el.video.play().catch(() => {});
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (run.stream === stream && run.phase !== 'idle' && !document.hidden) restartCamera();
    });
  }
}

/** Camera paused/restarted or recalibrating: drop half-finished timers and any alarm in progress. */
function interruptMonitoring() {
  monitor.interrupt();
  alarm.stop();
  hideAlarm();
}

async function restartCamera() {
  if (run.phase === 'idle') return;
  const old = run.stream;
  try {
    const stream = await openCamera({ deviceId: settings.cameraId });
    if (run.phase === 'idle') {
      stopStream(stream);
      return;
    }
    stopStream(old);
    attachStream(stream);
    interruptMonitoring();
    setProblem('camera', null);
  } catch (err) {
    setProblem('camera', `Camera stopped: ${err.message}`, () => restartCamera());
  }
}

// ---------------------------------------------------------------- frame loop

function startLoop() {
  cancelAnimationFrame(run.rafId);
  const frame = () => {
    if (run.phase !== 'calibrating' && run.phase !== 'monitoring') return;
    tick();
    run.rafId = requestAnimationFrame(frame);
  };
  run.rafId = requestAnimationFrame(frame);
  // Laptops: keep going while the window is in the background.
  if (!MOBILE && !run.ticker && 'Worker' in window) {
    try {
      run.ticker = new Worker(new URL('./ticker-worker.js', import.meta.url));
      run.ticker.onmessage = () => {
        if (document.hidden) tick();
      };
    } catch {
      run.ticker = null;
    }
  }
  run.ticker?.postMessage(100);
}

function stopLoop() {
  cancelAnimationFrame(run.rafId);
  run.ticker?.postMessage(0);
}

const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = 32;
lumaCanvas.height = 24;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });

/** Average brightness (0-255) of a tiny copy of the frame, plus a cheap signature. */
function sampleFrame(video) {
  try {
    lumaCtx.drawImage(video, 0, 0, 32, 24);
    const d = lumaCtx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    let sig = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += y;
      sig = (sig * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1000000007;
    }
    return { luma: sum / (d.length / 4), sig };
  } catch {
    return { luma: null, sig: null };
  }
}

function tick() {
  const now = performance.now();
  if (now - run.lastFrameAt < MIN_FRAME_MS) return;
  const video = el.video;
  if (!run.detector || run.recovering || video.readyState < 2 || !video.videoWidth) return;
  if (MOBILE && document.hidden) return;

  if (now - run.lumaAt >= LUMA_EVERY_MS || document.hidden) {
    const sample = sampleFrame(video);
    run.luma = sample.luma;
    run.lumaAt = now;
    // In a background tab the camera can freeze on its last frame. Never
    // judge a frozen picture (it might show closed eyes forever).
    if (sample.sig !== null && sample.sig === run.frameSig) {
      if (document.hidden && now - run.frameSigSince > 1000) return;
    } else {
      run.frameSig = sample.sig;
      run.frameSigSince = now;
    }
  }

  run.lastFrameAt = now;
  let result;
  try {
    result = run.detector.detect(video, now);
  } catch (err) {
    console.warn('Face tracking failed on this frame', err);
    if (run.detector.errors >= 3) recoverDetector();
    return;
  }
  run.frames.push(now);
  while (run.frames.length && now - run.frames[0] > 2000) run.frames.shift();
  const metrics = computeFaceMetrics(result, video.videoWidth, video.videoHeight);
  processFrame(now, metrics, result);
}

function processFrame(now, metrics, result) {
  const lit = light.update(now, { faceVisible: Boolean(metrics), luma: run.luma });
  if (lit.changed) applyNightLight(lit.on);

  if (run.phase === 'calibrating') {
    const progress = calibrator.add(now, metrics);
    showCalibration(progress, metrics);
    if (calibrator.isDone(now)) {
      const outcome = calibrator.result();
      if (outcome.ok) {
        monitor.setBaseline(outcome.baseline);
        if (!run.log) {
          run.log = new SessionLog(now);
          run.startedAt = now;
        }
        setPhase('monitoring');
        el.calibration.hidden = true;
        toast('Ready. Watching your eyes.', 'good', 2500);
      } else {
        calibrator.reset();
        el.calibrationText.textContent = 'Keep your eyes open and look ahead';
      }
    }
    renderCalibrating(now);
    drawOverlay(result, null);
    return;
  }

  const snap = monitor.update(now, metrics);
  run.snap = snap;
  run.log.add(now, { face: snap.face, closure: snap.closure, mouth: mouthOpenness(metrics), level: snap.level });
  for (const event of snap.events) onMonitorEvent(event, snap, now);
  render(now, snap, metrics);
  drawOverlay(result, snap);
}

function mouthOpenness(metrics) {
  if (!metrics) return NaN;
  if (Number.isFinite(metrics.jawOpen)) return metrics.jawOpen;
  return Number.isFinite(metrics.mar) ? Math.min(1, metrics.mar) : NaN;
}

const DROWSY_TEXT = {
  'heavy-eyes': 'Your eyelids look heavy. Plan a break soon.',
  perclos: 'Your eyes have been closing a lot. Time for a break.',
  'long-blinks': 'Long, slow blinks: you may be getting drowsy.',
  yawning: 'Lots of yawning. Pull over for a rest when you can.',
};

const DROWSY_SHORT = {
  'heavy-eyes': 'Heavy eyelids',
  perclos: 'Eyes closing often',
  'long-blinks': 'Long blinks',
  yawning: 'Frequent yawning',
};

function onMonitorEvent(event, snap, now) {
  switch (event) {
    case 'alarm-start':
      run.log.event(now, 'alarm');
      showAlarm(snap.alarm.reason);
      alarm.start(settings.alarmSeconds * 1000);
      checkBreak(now);
      break;
    case 'alarm-extend':
      alarm.extend(settings.alarmSeconds * 1000);
      break;
    case 'alarm-end':
      alarm.stop();
      hideAlarm();
      break;
    case 'drowsy':
      run.log.event(now, 'drowsy');
      if (settings.drowsyWarnings) {
        alarm.chime();
        toast(DROWSY_TEXT[snap.drowsy?.reason] ?? 'You look drowsy. Plan a break.', 'drowsy', 6000);
      }
      break;
    case 'yawn':
      run.log.event(now, 'yawn');
      if (snap.counts.yawns >= 2) toast(`Yawn #${snap.counts.yawns}. Getting tired?`, 'drowsy', 3000);
      break;
    case 'blink':
      run.log.blinks += 1;
      break;
    default:
      break;
  }
}

function checkBreak(now) {
  const recent = monitor.recentAlerts(now);
  if (recent >= 2) {
    el.breakBanner.textContent = `You nodded off ${recent} times in 15 minutes. Please pull over somewhere safe and rest.`;
    el.breakBanner.hidden = false;
  }
}

// ---------------------------------------------------------------- rendering

function setStatus(level, label, sub) {
  if (el.status.dataset.level !== level) el.status.dataset.level = level;
  if (el.statusLabel.textContent !== label) el.statusLabel.textContent = label;
  if (el.statusSub.textContent !== sub) el.statusSub.textContent = sub;
}

function showLoading(text) {
  el.loadingText.textContent = text;
  el.loading.hidden = false;
}

function hideLoading() {
  el.loading.hidden = true;
}

function showCalibration(progress, metrics) {
  el.calibrationRing.style.setProperty('--p', progress.toFixed(3));
  el.calibrationPct.textContent = `${Math.round(progress * 100)}%`;
  if (!metrics) {
    el.calibrationText.textContent = light.on
      ? 'Looking for your face… (night light on)'
      : "Can't see your face yet. Point the front camera at you.";
  } else if (progress < 1) {
    el.calibrationText.textContent = 'Look ahead with your eyes open';
  }
}

function renderCalibrating(now) {
  if (now - run.lastRenderAt < 150) return;
  run.lastRenderAt = now;
  setStatus('unknown', 'Calibrating…', 'Hold still for 2 seconds');
  el.statTime.textContent = run.log ? formatClock((now - run.startedAt) / 1000) : '0:00';
  el.nlText.textContent = 'Night light on · calibrating';
}

function render(now, snap, metrics) {
  const levelChanged = snap.level !== run.lastLevel;
  if (!levelChanged && !snap.events.length && now - run.lastRenderAt < 100) return;
  run.lastRenderAt = now;
  const elapsed = (now - run.startedAt) / 1000;

  let level = snap.level;
  let label;
  let sub;
  if (snap.level === 'sleeping') {
    label = 'Sleeping!';
    sub = snap.alarm?.reason === 'noface' ? "Can't see your face" : 'Eyes closed. Wake up!';
  } else if (!snap.face) {
    if (level === 'active') level = 'unknown';
    label = 'Face not visible';
    sub = light.on ? 'Night light is on' : 'Point the camera at your face';
  } else if (snap.level === 'drowsy') {
    label = 'Drowsy';
    sub = DROWSY_SHORT[snap.drowsy?.reason] ?? 'Signs of tiredness';
  } else {
    label = 'Active';
    sub = snap.yawning ? 'Yawning…' : snap.eyes === 'closing' ? 'Eyes closing…' : 'Eyes open';
  }
  setStatus(level, label, sub);
  root.dataset.level = snap.level;
  root.dataset.eyes = snap.face ? snap.eyes : 'unknown';
  if (levelChanged) {
    if (run.lastLevel !== null) el.srLive.textContent = label;
    run.lastLevel = snap.level;
  }

  const pct = Math.round(snap.closure * 100);
  el.meterFill.style.width = `${pct}%`;
  el.meterValue.textContent = snap.face ? `${pct}%` : '–';
  el.meter.dataset.state = snap.eyes === 'closed' ? 'closed' : snap.eyes === 'closing' ? 'closing' : 'open';
  el.statTime.textContent = formatClock(elapsed);
  el.statAlarms.textContent = String(snap.counts.alerts);
  el.statDrowsy.textContent = String(snap.counts.drowsy);
  el.statYawns.textContent = String(snap.counts.yawns);
  el.nlText.textContent = `${label} · ${formatClock(elapsed)}`;

  if (settings.showDetails) {
    const fps = run.frames.length > 1 ? ((run.frames.length - 1) * 1000) / (run.frames[run.frames.length - 1] - run.frames[0]) : 0;
    const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    el.details.textContent = [
      `tracker ${run.detector?.delegate ?? '?'} · ${fps.toFixed(0)} fps · light ${light.on ? `on (${light.reason})` : 'off'} · brightness ${f(run.luma, 0)}`,
      `EAR ${f(metrics?.ear, 3)} (open ${f(monitor.baseline.earOpen, 3)}) · blink ${f(metrics?.blink)} (open ${f(monitor.baseline.blinkOpen)})`,
      `closure ${f(snap.closure)} · shut ${Math.round(snap.closedFor)} ms · PERCLOS ${(snap.perclos * 100).toFixed(0)}%`,
      `mouth MAR ${f(metrics?.mar)} · jawOpen ${f(metrics?.jawOpen)} · blinks ${snap.counts.blinks} · long ${snap.counts.longBlinks}`,
    ].join('\n');
  }
}

const overlayCtx = el.overlay.getContext('2d');

function clearOverlay() {
  overlayCtx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  run.overlayDrawn = false;
}

function drawOverlay(result, snap) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!settings.showPreview || light.on || !landmarks) {
    if (run.overlayDrawn) clearOverlay();
    return;
  }
  const canvas = el.overlay;
  const w = el.video.videoWidth;
  const h = el.video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = overlayCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, w / 300);
  const path = (indices) => {
    ctx.beginPath();
    indices.forEach((i, n) => (n ? ctx.lineTo(landmarks[i].x * w, landmarks[i].y * h) : ctx.moveTo(landmarks[i].x * w, landmarks[i].y * h)));
    ctx.stroke();
  };
  ctx.strokeStyle = !snap ? '#3987e5' : snap.eyes === 'closed' ? '#d03b3b' : snap.eyes === 'closing' ? '#fab219' : '#0ca30c';
  path(OUTLINES.rightEye);
  path(OUTLINES.leftEye);
  ctx.strokeStyle = snap?.yawning ? '#fab219' : 'rgba(255, 255, 255, 0.55)';
  path(OUTLINES.mouth);
  run.overlayDrawn = true;
}

// ---------------------------------------------------------------- night light & alarm

function applyNightLight(on) {
  const wasOn = root.dataset.light === 'on';
  el.nightlight.hidden = !on;
  root.dataset.light = on ? 'on' : 'off';
  el.lightBtn.setAttribute('aria-pressed', String(on));
  el.lightBtnText.textContent = on ? 'Light off' : 'Light on';
  // Android app only: full brightness while the light is on; always hand
  // brightness back to the phone's own setting when it goes off.
  if (on !== wasOn) awake.setBrightness(on && settings.maxBrightness ? 1 : null);
  if (on && !wasOn) clearOverlay();
}

function toggleLight() {
  if (light.on) {
    if (light.mode === 'on') light.setMode('auto');
    light.snooze();
  } else {
    if (light.mode === 'off') light.setMode('auto');
    light.wake();
  }
  applyNightLight(light.on);
}

function showAlarm(reason) {
  el.alarmTitle.textContent = 'WAKE UP!';
  el.alarmSub.textContent = reason === 'noface' ? "Can't see your face" : 'Your eyes were closed';
  el.alarm.hidden = false;
  root.dataset.alarm = 'on';
}

function hideAlarm() {
  el.alarm.hidden = true;
  root.dataset.alarm = 'off';
}

function dismissAlarm() {
  alarm.unlock(); // this tap also re-enables sound if the browser had blocked it
  monitor.dismissAlarm(performance.now());
  alarm.stop();
  hideAlarm();
}

// ---------------------------------------------------------------- summary

function openSummary(log) {
  const s = log.summary();
  const kpis = [
    ['Drive time', formatClock(s.durationS)],
    ['Sleep alarms', String(s.alarms)],
    ['Drowsy warnings', String(s.drowsy)],
    ['Yawns', String(s.yawns)],
    ['Blinks / min', s.blinksPerMin === null ? '–' : String(Math.round(s.blinksPerMin))],
  ];
  el.summaryKpis.replaceChildren(
    ...kpis.map(([label, value]) => {
      const box = document.createElement('div');
      box.className = 'kpi';
      const l = document.createElement('div');
      l.className = 'kpi-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'kpi-value';
      v.textContent = value;
      box.append(l, v);
      return box;
    }),
  );
  el.summaryAdvice.textContent =
    s.alarms > 0
      ? `Your eyes closed ${s.alarms} time${s.alarms === 1 ? '' : 's'} long enough to sound the alarm. Please rest before you drive again.`
      : s.drowsy > 0
        ? 'You showed signs of drowsiness. Plan regular breaks, or swap drivers.'
        : 'No drowsiness detected this time. Drive safe.';

  const legendItems = [['line-key', 'Eye openness']];
  if (s.alarms) legendItems.push(['dot-key key-alarm', EVENT_LABELS.alarm]);
  if (s.drowsy) legendItems.push(['dot-key key-drowsy', EVENT_LABELS.drowsy]);
  if (s.yawns) legendItems.push(['dot-key key-yawn', EVENT_LABELS.yawn]);
  el.summaryLegend.replaceChildren(
    ...legendItems.map(([cls, text]) => {
      const li = document.createElement('li');
      const key = document.createElement('span');
      key.className = cls;
      li.append(key, document.createTextNode(text));
      return li;
    }),
  );

  el.summaryTable.replaceChildren(
    ...log.minuteRows().map((row) => {
      const tr = document.createElement('tr');
      const counts = {};
      for (const e of row.events) counts[e] = (counts[e] ?? 0) + 1;
      const events = Object.entries(counts)
        .map(([type, n]) => `${EVENT_LABELS[type] ?? type}${n > 1 ? ` ×${n}` : ''}`)
        .join(', ');
      for (const text of [`${row.minute}–${row.minute + 1} min`, row.eye === null ? 'Face not visible' : `${Math.round(row.eye * 100)}%`, events || '–']) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );

  el.summaryDialog.showModal();
  if (!run.chart) run.chart = new SessionChart(el.summaryChart);
  run.chart.setData(log.series(), log.events, s.durationS);
}

// ---------------------------------------------------------------- offline / install

function renderOfflineChip(status) {
  run.offline = status;
  const chip = el.offlineChip;
  const text = chip.querySelector('.chip-text');
  chip.dataset.state = status.state;
  const pct = status.total ? Math.round((100 * (status.done ?? 0)) / status.total) : null;
  text.textContent = {
    checking: 'Checking…',
    saving: pct === null ? 'Saving for offline…' : `Saving for offline ${pct}%`,
    ready: status.native ? 'Offline app' : 'Works offline',
    error: 'Offline save failed',
    unsupported: 'Needs internet',
  }[status.state];
  chip.title = {
    ready: 'Everything is saved on this device. The app works without internet.',
    saving: 'Downloading the app and face model so it works without internet.',
    error: 'Could not save for offline use. Open the app again with internet.',
    unsupported: 'This browser cannot save the app for offline use.',
  }[status.state] ?? '';
  setIndicator(el.indOffline, status.state === 'ready');
}

function showPlatformHint() {
  let hint = '';
  if (PLATFORM === 'ios' && !isStandalone()) {
    hint = 'iPhone tip: tap Share → Add to Home Screen. It then opens like an app and works offline.';
  } else if (PLATFORM === 'android' && !isStandalone()) {
    hint = 'Android tip: tap “Install app” (or ⋮ → Add to Home screen) to use it like an app, even offline.';
  } else if (PLATFORM === 'desktop') {
    hint = "Laptop tip: keep this window open on screen. Browsers pause the camera when it's minimised.";
  }
  el.platformHint.textContent = hint;
  el.platformHint.hidden = !hint;
  for (const node of document.querySelectorAll('[data-platform]')) {
    if (node.dataset.platform === PLATFORM) node.dataset.visible = '';
  }
}

// ---------------------------------------------------------------- events

el.start.addEventListener('click', onStartTap);
el.permAllow.addEventListener('click', () => beginMonitoring());
el.permCancel.addEventListener('click', () => el.permDialog.close());
el.permTest.addEventListener('click', () => {
  const ok = alarm.unlock();
  setPerm('sound', ok ? 'granted' : 'failed');
  alarm.start(1500);
});
el.stopBtn.addEventListener('click', () => stopMonitoring());
el.nlStop.addEventListener('click', () => stopMonitoring());
el.lightBtn.addEventListener('click', toggleLight);
el.nlOff.addEventListener('click', toggleLight);
el.recalBtn.addEventListener('click', () => {
  if (run.phase !== 'monitoring' && run.phase !== 'calibrating') return;
  calibrator.reset();
  interruptMonitoring();
  setPhase('calibrating');
  el.calibration.hidden = false;
  showCalibration(0, run.snap?.face ? {} : null);
});
el.fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else root.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
});
el.alarm.addEventListener('click', dismissAlarm);
document.addEventListener('keydown', (e) => {
  if (!el.alarm.hidden && (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape')) {
    e.preventDefault();
    dismissAlarm();
  }
});

el.settingsBtn.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', () => el.settingsDialog.close());
el.settingsForm.addEventListener('input', onSettingsChanged);
el.settingsForm.addEventListener('change', onSettingsChanged);
el.settingsForm.addEventListener('submit', (e) => e.preventDefault());
el.testAlarm.addEventListener('click', () => {
  alarm.unlock();
  alarm.start(1500);
});
el.resetSettings.addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  saveSettings(settings);
  fillSettingsForm();
  applySettings();
});
el.summaryClose.addEventListener('click', () => el.summaryDialog.close());

for (const dialog of [el.permDialog, el.settingsDialog, el.summaryDialog]) {
  // Tap on the dimmed backdrop closes the sheet.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && dialog !== el.permDialog) dialog.close();
  });
}
el.permDialog.addEventListener('close', () => {
  el.permAllow.disabled = false;
});

alarm.onBlockedChange = (blocked) => {
  setIndicator(el.indSound, !blocked);
  setProblem('sound', blocked ? 'Alarm sound is blocked by the browser.' : null, () => alarm.unlock());
};

awake.onChange((status) => {
  if (run.phase === 'idle') return;
  setIndicator(el.indScreen, status.active);
  setProblem('screen', status.needsTap ? 'The screen may turn off by itself.' : null, () => awake.startVideo());
});

// Android Back button / gesture while monitoring: don't quietly leave the app.
window.addEventListener('popstate', () => {
  if (run.ignorePop) {
    run.ignorePop = false;
    return;
  }
  if (run.phase !== 'idle') {
    history.pushState({ lnsMonitoring: true }, '');
    toast('Monitoring is on. Tap Stop to end it.', 'drowsy');
  }
});

document.addEventListener('visibilitychange', () => {
  if (run.phase === 'idle') return;
  if (document.hidden) {
    run.hiddenAt = performance.now();
    return;
  }
  const away = run.hiddenAt === null ? 0 : performance.now() - run.hiddenAt;
  run.hiddenAt = null;
  const track = run.stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') restartCamera();
  else el.video.play().catch(() => {});
  if (MOBILE && away > 500) {
    interruptMonitoring();
    if (away > 3000) toast('Monitoring resumed. Keep this app on screen while you drive.', 'drowsy', 5000);
  }
});

// ---------------------------------------------------------------- boot

applySettings();
showPlatformHint();
setupPwa({
  onStatus: renderOfflineChip,
  onUpdateReady: (apply) => {
    el.updateBtn.hidden = false;
    el.updateBtn.onclick = () => {
      if (run.phase !== 'idle') {
        toast('Stop monitoring first, then tap Update.');
        return;
      }
      apply();
    };
  },
  onInstallable: (prompt) => {
    el.installBtn.hidden = !prompt;
    el.installBtn.onclick = prompt
      ? async () => {
          await prompt();
          el.installBtn.hidden = true;
        }
      : null;
  },
});

if (params.has('debug')) {
  // Test hook (used by tests/e2e). Harmless in normal use.
  window.__lns = { run, monitor, light, alarm, awake, settings, calibrator };
}
