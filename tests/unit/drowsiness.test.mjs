import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Calibrator,
  DrowsinessMonitor,
  EYES,
  closureScore,
  computeFaceMetrics,
  eyeAspectRatio,
  median,
  mouthAspectRatio,
} from '../../js/drowsiness.js';

const OPEN = { ear: 0.3, blink: 0.05 };
const CLOSED = { ear: 0.1, blink: 0.92 };
const SQUINT = { ear: 0.19, blink: 0.45 }; // eyes about half closed
const FRAME_MS = 1000 / 30;

/** Runs the monitor from t0 to t1 at 30 fps; metricsAt(t) returns metrics or null. */
function run(monitor, t0, t1, metricsAt, log = []) {
  let snap;
  for (let t = t0; t < t1; t += FRAME_MS) {
    snap = monitor.update(t, metricsAt(t));
    for (const e of snap.events) log.push({ t, e, alarm: snap.alarm });
  }
  return { snap, log };
}

function calibratedMonitor(options) {
  const m = new DrowsinessMonitor(options);
  m.setBaseline({ earOpen: OPEN.ear, blinkOpen: OPEN.blink });
  return m;
}

function fakeLandmarks({ eyeWidth = 0.1, gap = 0.03 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const place = (eye, cx) => {
    lm[eye.corners[0]] = { x: cx - eyeWidth / 2, y: 0.4, z: 0 };
    lm[eye.corners[1]] = { x: cx + eyeWidth / 2, y: 0.4, z: 0 };
    eye.lids.forEach(([u, l], i) => {
      const x = cx - eyeWidth / 4 + (i * eyeWidth) / 4;
      lm[u] = { x, y: 0.4 - gap / 2, z: 0 };
      lm[l] = { x, y: 0.4 + gap / 2, z: 0 };
    });
  };
  place(EYES.right, 0.4);
  place(EYES.left, 0.6);
  return lm;
}

test('eye aspect ratio is lid gap over eye width', () => {
  const lm = fakeLandmarks({ eyeWidth: 0.1, gap: 0.03 });
  assert.ok(Math.abs(eyeAspectRatio(lm, EYES.left) - 0.3) < 1e-9);
  assert.ok(Math.abs(eyeAspectRatio(lm, EYES.right) - 0.3) < 1e-9);
  // Non-square video: normalised x and y must be scaled to pixels first.
  assert.ok(Math.abs(eyeAspectRatio(lm, EYES.left, 640, 480) - (0.03 * 480) / (0.1 * 640)) < 1e-9);
});

test('computeFaceMetrics reads landmarks and blendshapes', () => {
  assert.equal(computeFaceMetrics({ faceLandmarks: [] }, 640, 480), null);
  assert.equal(computeFaceMetrics(null, 640, 480), null);
  const result = {
    faceLandmarks: [fakeLandmarks({ gap: 0.03 })],
    faceBlendshapes: [
      {
        categories: [
          { categoryName: 'eyeBlinkLeft', score: 0.2 },
          { categoryName: 'eyeBlinkRight', score: 0.4 },
        ],
      },
    ],
  };
  const m = computeFaceMetrics(result, 100, 100);
  assert.ok(Math.abs(m.ear - 0.3) < 1e-9);
  assert.ok(Math.abs(m.blink - 0.3) < 1e-9);
  // Works without blendshapes too.
  const noBlend = computeFaceMetrics({ faceLandmarks: [fakeLandmarks()] }, 100, 100);
  assert.ok(Number.isFinite(noBlend.ear));
  assert.ok(Number.isNaN(noBlend.blink));
});

test('median ignores non-numbers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, NaN, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('calibration takes the median so a blink does not skew it', () => {
  const c = new Calibrator({ durationMs: 2000, minSamples: 12 });
  let t = 0;
  for (; t < 2100; t += FRAME_MS) {
    const blinking = t > 900 && t < 1100;
    c.add(t, blinking ? CLOSED : OPEN);
  }
  assert.equal(c.isDone(t), true);
  const r = c.result();
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.baseline.earOpen - OPEN.ear) < 1e-9);
  assert.ok(Math.abs(r.baseline.blinkOpen - OPEN.blink) < 1e-9);
});

test('calibration needs both enough time and enough face samples', () => {
  const c = new Calibrator({ durationMs: 2000, minSamples: 12 });
  c.add(0, OPEN);
  c.add(5000, OPEN); // plenty of time but only two samples
  assert.equal(c.isDone(5000), false);
  for (let i = 0; i < 20; i++) c.add(5001 + i, null); // frames without a face don't count
  assert.equal(c.isDone(6000), false);
});

test('calibration refuses closed eyes', () => {
  const c = new Calibrator({ durationMs: 500, minSamples: 5 });
  for (let t = 0; t < 600; t += FRAME_MS) c.add(t, CLOSED);
  assert.deepEqual(c.result(), { ok: false, reason: 'eyes-closed' });
});

test('closure score: ~0 when open, ~1 when shut', () => {
  const base = { earOpen: 0.3, blinkOpen: 0.05 };
  assert.ok(closureScore(OPEN, base) < 0.05);
  assert.ok(closureScore(CLOSED, base) > 0.95);
  const half = closureScore(SQUINT, base);
  assert.ok(half > 0.3 && half < 0.6, `squint closure ${half}`);
});

test('normal blinks never sound the alarm', () => {
  const m = calibratedMonitor();
  // A 250 ms blink every 2 seconds for 20 seconds.
  const { log } = run(m, 0, 20000, (t) => (t % 2000 < 250 ? CLOSED : OPEN));
  assert.equal(log.filter((l) => l.e === 'alarm-start').length, 0);
  assert.ok(m.blinks >= 9, `counted ${m.blinks} blinks`);
});

test('a slow 600 ms blink is still not an alarm at the 1 s setting', () => {
  const m = calibratedMonitor({ closedMs: 1000 });
  const { log } = run(m, 0, 5000, (t) => (t > 1000 && t < 1600 ? CLOSED : OPEN));
  assert.equal(log.filter((l) => l.e === 'alarm-start').length, 0);
});

test('eyes closed for 1 second starts the alarm', () => {
  const m = calibratedMonitor({ closedMs: 1000, alarmMs: 3000 });
  const closeAt = 2000;
  const { log } = run(m, 0, 4000, (t) => (t >= closeAt ? CLOSED : OPEN));
  const start = log.find((l) => l.e === 'alarm-start');
  assert.ok(start, 'alarm started');
  assert.equal(start.alarm.reason, 'eyes');
  const delay = start.t - closeAt;
  assert.ok(delay >= 1000 && delay <= 1000 + 3 * FRAME_MS, `alarm after ${delay} ms`);
});

test('alarm lasts the full 3 seconds even if the eyes open straight away', () => {
  const m = calibratedMonitor({ closedMs: 1000, alarmMs: 3000 });
  const { log } = run(m, 0, 10000, (t) => (t >= 1000 && t < 2100 ? CLOSED : OPEN));
  const start = log.find((l) => l.e === 'alarm-start');
  const end = log.find((l) => l.e === 'alarm-end');
  assert.ok(start && end);
  const length = end.t - start.t;
  assert.ok(length >= 3000 && length < 3000 + 2 * FRAME_MS, `alarm lasted ${length} ms`);
  assert.equal(log.filter((l) => l.e === 'alarm-extend').length, 0);
});

test('alarm keeps going while the eyes stay shut, then stops', () => {
  const m = calibratedMonitor({ closedMs: 1000, alarmMs: 3000 });
  // Shut from 1 s to 9 s: alarm at ~2 s, repeats at ~5 s and ~8 s, and the
  // cycle running when the eyes open (at 9 s) finishes at ~11 s.
  const { log } = run(m, 0, 15000, (t) => (t >= 1000 && t < 9000 ? CLOSED : OPEN));
  assert.equal(log.filter((l) => l.e === 'alarm-start').length, 1);
  assert.equal(log.filter((l) => l.e === 'alarm-extend').length, 2);
  const end = log.find((l) => l.e === 'alarm-end');
  assert.ok(end.t > 11000 && end.t < 11200, `ended at ${end.t}`);
});

test('the closed-eyes time setting is respected', () => {
  const m = calibratedMonitor({ closedMs: 2000 });
  const { log } = run(m, 0, 5000, (t) => (t >= 1000 && t < 2800 ? CLOSED : OPEN));
  assert.equal(log.filter((l) => l.e === 'alarm-start').length, 0, '1.8 s < 2 s: no alarm');
  const m2 = calibratedMonitor({ closedMs: 500 });
  const r2 = run(m2, 0, 3000, (t) => (t >= 1000 && t < 1700 ? CLOSED : OPEN));
  assert.equal(r2.log.filter((l) => l.e === 'alarm-start').length, 1, '0.7 s > 0.5 s: alarm');
});

test('a blink followed by a head turn (face lost) is not an alarm', () => {
  const m = calibratedMonitor({ closedMs: 1000 });
  const { log } = run(m, 0, 6000, (t) => {
    if (t < 1000) return OPEN;
    if (t < 1150) return CLOSED; // blink...
    if (t < 3500) return null; // ...then the face turns away
    return OPEN;
  });
  assert.equal(log.filter((l) => l.e === 'alarm-start').length, 0);
});

test('eyes shut for a while and then the head drops out of view still alarms', () => {
  const m = calibratedMonitor({ closedMs: 1000 });
  const { log } = run(m, 0, 4000, (t) => {
    if (t < 1000) return OPEN;
    if (t < 1700) return CLOSED; // 700 ms shut
    return null; // head drops, face lost
  });
  const start = log.find((l) => l.e === 'alarm-start');
  assert.ok(start, 'alarm started');
  assert.ok(start.t >= 2000 && start.t < 2100);
});

test('optional no-face alert', () => {
  const off = calibratedMonitor({ noFaceAlertMs: 0 });
  const r1 = run(off, 0, 10000, (t) => (t < 1000 ? OPEN : null));
  assert.equal(r1.log.filter((l) => l.e === 'alarm-start').length, 0);

  const on = calibratedMonitor({ noFaceAlertMs: 5000 });
  const r2 = run(on, 0, 7000, (t) => (t < 1000 ? OPEN : null));
  const start = r2.log.find((l) => l.e === 'alarm-start');
  assert.ok(start && start.alarm.reason === 'noface');
  assert.ok(start.t >= 6000 && start.t < 6100);

  // Never alarms if a face was never seen (e.g. camera pointing elsewhere at start).
  const never = calibratedMonitor({ noFaceAlertMs: 2000 });
  const r3 = run(never, 0, 5000, () => null);
  assert.equal(r3.log.filter((l) => l.e === 'alarm-start').length, 0);
});

test('sensitivity changes how much closing counts', () => {
  const squintFor = (sensitivity) => {
    const m = calibratedMonitor({ sensitivity, closedMs: 1000 });
    return run(m, 0, 4000, (t) => (t >= 1000 ? SQUINT : OPEN)).log.filter((l) => l.e === 'alarm-start').length;
  };
  assert.equal(squintFor('low'), 0);
  assert.equal(squintFor('normal'), 0);
  assert.equal(squintFor('high'), 1);
});

test('dismissing the alarm stops it; it only comes back after a fresh 1 s closure', () => {
  const m = calibratedMonitor({ closedMs: 1000, alarmMs: 3000 });
  const { log } = run(m, 0, 2200, (t) => (t >= 1000 ? CLOSED : OPEN));
  assert.ok(log.some((l) => l.e === 'alarm-start'));
  assert.equal(m.dismissAlarm(2200), true);
  assert.equal(m.update(2233, CLOSED).alarm, null);
  // Still shut: alarm returns about 1 s later.
  const r2 = run(m, 2266, 3600, () => CLOSED);
  const again = r2.log.find((l) => l.e === 'alarm-start');
  assert.ok(again && again.t >= 3200, `came back at ${again?.t}`);
});

test('baseline adapts upward but never drifts far below calibration', () => {
  const m = calibratedMonitor();
  run(m, 0, 120000, () => ({ ear: 0.26, blink: 0.1 })); // drowsy, drooping eyelids for 2 min
  assert.ok(m.baseline.earOpen >= 0.3 * 0.85 - 1e-9, `baseline ${m.baseline.earOpen}`);
  const m2 = calibratedMonitor();
  run(m2, 0, 120000, () => ({ ear: 0.34, blink: 0.03 })); // eyes wider than at calibration
  assert.ok(m2.baseline.earOpen > 0.32, `baseline ${m2.baseline.earOpen}`);
});

test('recent alert count for the "take a break" warning', () => {
  const m = calibratedMonitor({ closedMs: 1000, alarmMs: 3000 });
  // Three separate dozes, 20 s apart.
  run(m, 0, 70000, (t) => (t % 20000 > 10000 && t % 20000 < 11500 ? CLOSED : OPEN));
  assert.equal(m.alerts.length, 3);
  assert.equal(m.recentAlerts(70000), 3);
  assert.equal(m.recentAlerts(70000 + 15 * 60 * 1000), 0);
});

// ---------------------------------------------------------------------------
// Fatigue signs (the "drowsy" level) and yawns.

const HEAVY = { ear: 0.21, blink: 0.35 }; // drooping eyelids, not shut
const YAWNING = { jawOpen: 0.75, mar: 0.8 };
const MOUTH_SHUT = { jawOpen: 0.02, mar: 0.02 };
const events = (log, name) => log.filter((l) => l.e === name);

test('mouth aspect ratio is inner-lip gap over mouth width', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[78] = { x: 0.4, y: 0.7, z: 0 };
  lm[308] = { x: 0.6, y: 0.7, z: 0 };
  for (const [u, l] of [[82, 87], [13, 14], [312, 317]]) {
    lm[u] = { x: 0.5, y: 0.65, z: 0 };
    lm[l] = { x: 0.5, y: 0.75, z: 0 };
  }
  assert.ok(Math.abs(mouthAspectRatio(lm) - 0.5) < 1e-9);
});

test('a yawn is the mouth held wide open; talking is not', () => {
  const m = calibratedMonitor();
  const yawn = run(m, 0, 6000, (t) => ({ ...OPEN, ...(t > 1000 && t < 4000 ? YAWNING : MOUTH_SHUT) }));
  assert.equal(events(yawn.log, 'yawn').length, 1);

  const m2 = calibratedMonitor();
  // Talking: mouth opens and closes several times a second.
  const talk = run(m2, 0, 10000, (t) => ({ ...OPEN, ...(t % 300 < 150 ? YAWNING : MOUTH_SHUT) }));
  assert.equal(events(talk.log, 'yawn').length, 0);
});

test('three yawns within 10 minutes raise a drowsy warning', () => {
  const m = calibratedMonitor();
  const { log, snap } = run(m, 0, 70000, (t) => ({ ...OPEN, ...(t % 20000 > 5000 && t % 20000 < 8000 ? YAWNING : MOUTH_SHUT) }));
  assert.equal(events(log, 'yawn').length, 4);
  const warn = events(log, 'drowsy');
  assert.equal(warn.length, 1, 'one chime (cooldown stops repeats)');
  assert.equal(m.drowsy?.reason ?? 'yawning', 'yawning');
  assert.equal(events(log, 'alarm-start').length, 0);
  assert.ok(snap.counts.yawns === 4);
});

test('eyes shut during a yawn get extra time before the sleeping alarm', () => {
  const during = calibratedMonitor({ closedMs: 1000 });
  const r1 = run(during, 0, 6000, (t) => {
    const yawning = t > 1000 && t < 4500;
    const shut = t > 1800 && t < 3600; // 1.8 s shut while yawning
    return { ...(shut ? CLOSED : OPEN), ...(yawning ? YAWNING : MOUTH_SHUT) };
  });
  assert.equal(events(r1.log, 'alarm-start').length, 0);

  const without = calibratedMonitor({ closedMs: 1000 });
  const r2 = run(without, 0, 6000, (t) => ({ ...(t > 1800 && t < 3600 ? CLOSED : OPEN), ...MOUTH_SHUT }));
  assert.equal(events(r2.log, 'alarm-start').length, 1);
});

test('falling asleep straight after a yawn still alarms', () => {
  const m = calibratedMonitor({ closedMs: 1000 });
  const { log } = run(m, 0, 8000, (t) => {
    const yawning = t > 1000 && t < 3000;
    return { ...(t > 2000 ? CLOSED : OPEN), ...(yawning ? YAWNING : MOUTH_SHUT) };
  });
  const start = events(log, 'alarm-start')[0];
  assert.ok(start, 'alarm started');
  // Mouth closes at 3 s; eyes have been shut since 2 s, so it fires right then.
  assert.ok(start.t >= 3000 && start.t < 3200, `alarm at ${start.t}`);
});

test('repeated long blinks raise a drowsy warning (not the alarm)', () => {
  const m = calibratedMonitor({ closedMs: 1000 });
  const { log } = run(m, 0, 30000, (t) => (t % 8000 > 4000 && t % 8000 < 4650 ? CLOSED : OPEN));
  assert.ok(events(log, 'long-blink').length >= 3);
  const warn = events(log, 'drowsy');
  assert.equal(warn.length, 1);
  assert.ok(warn[0].t > 20000, 'only after the third long blink');
  assert.equal(events(log, 'alarm-start').length, 0);
});

test('heavy, drooping eyelids for a few seconds raise a drowsy warning', () => {
  const m = calibratedMonitor({ heavyEyesMs: 4000 });
  const { log } = run(m, 0, 9000, (t) => (t > 2000 ? HEAVY : OPEN));
  const warn = events(log, 'drowsy')[0];
  assert.ok(warn, 'warned');
  assert.ok(warn.t >= 6000 && warn.t < 6200, `warned at ${warn.t}`);
  assert.equal(events(log, 'alarm-start').length, 0, 'heavy is not shut');
  assert.equal(m.level(), 'drowsy');
});

test('eyes shut a large share of the last minute (PERCLOS) raises a drowsy warning', () => {
  const m = calibratedMonitor();
  // Quick 350 ms blinks every 1.4 s: each is short, but together the eyes are
  // shut ~25% of the time.
  const { log } = run(m, 0, 45000, (t) => (t % 1400 < 350 ? CLOSED : OPEN));
  assert.equal(events(log, 'long-blink').length, 0);
  const warn = events(log, 'drowsy')[0];
  assert.ok(warn && warn.t >= 30000, `perclos warning at ${warn?.t}`);
  assert.equal(m.drowsy?.reason, 'perclos');
});

test('levels go active -> drowsy -> sleeping -> back', () => {
  const m = calibratedMonitor({ heavyEyesMs: 3000, closedMs: 1000, alarmMs: 3000 });
  const levels = [];
  run(m, 0, 30000, (t) => {
    const snap = m.snapshot(t, OPEN);
    if (levels[levels.length - 1] !== snap.level) levels.push(snap.level);
    if (t < 2000) return OPEN;
    if (t < 6000) return HEAVY;
    if (t < 7500) return CLOSED;
    return OPEN;
  });
  assert.deepEqual(levels.slice(0, 3), ['active', 'drowsy', 'sleeping']);
  assert.equal(m.level(), 'active');
});
