// Pure drowsiness-detection logic. No browser APIs here, so it can be unit
// tested in Node (see tests/unit).
//
// Signals computed for every camera frame (MediaPipe Face Landmarker):
//   - Eye Aspect Ratio (EAR): eyelid gap / eye width. ~0.25-0.35 open, ~0.1 shut.
//   - "eyeBlinkLeft/Right" blendshapes: 0 = open, 1 = shut.
//   - Mouth Aspect Ratio (MAR): inner-lip gap / mouth width, plus the
//     "jawOpen" blendshape. Used to spot yawns.
//
// Compared with fixed-threshold detectors, everything here is relative to a
// 2-second calibration of the driver's own open eyes, and every rule is in
// milliseconds rather than frame counts, so it behaves the same on a fast
// laptop and a slow phone.
//
// Three alert levels:
//   active   - all good.
//   drowsy   - early fatigue signs: heavy eyelids, eyes closed a large share
//              of the last minute (PERCLOS), repeated long blinks or yawns.
//              -> soft warning chime.
//   sleeping - eyes shut for `closedMs` (1 s by default).
//              -> loud alarm for `alarmMs` (3 s), repeated until they open.

// Landmark indices in MediaPipe's 478-point face mesh.
export const EYES = {
  right: { corners: [33, 133], lids: [[160, 144], [159, 145], [158, 153]] },
  left: { corners: [362, 263], lids: [[385, 380], [386, 374], [387, 373]] },
};
export const MOUTH = { corners: [78, 308], lips: [[82, 87], [13, 14], [312, 317]] };

// Closure is 0 for normally open eyes and 1 for fully shut eyes.
//   close/open - closure that counts as "eyes shut" / "open again" (hysteresis)
//   heavy      - closure that counts as heavy, drooping eyelids
//   perclos    - share of the last minute spent with eyes shut that means drowsy
export const SENSITIVITY = {
  low: { close: 0.72, open: 0.5, heavy: 0.45, perclos: 0.2 },
  normal: { close: 0.6, open: 0.42, heavy: 0.36, perclos: 0.15 },
  high: { close: 0.48, open: 0.32, heavy: 0.28, perclos: 0.12 },
};

// Mouth wide open (yawn) and closed-again thresholds.
export const YAWN = { jawOpen: 0.5, mar: 0.55, endJawOpen: 0.3, endMar: 0.35 };

// EAR of a fully closed eye relative to the person's own open-eye EAR.
const CLOSED_EAR_RATIO = 0.35;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function dist(a, b, w, h) {
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * h, ((a.z || 0) - (b.z || 0)) * w);
}

/** Average gap between paired points divided by the distance between the corners. */
function aspectRatio(landmarks, { corners, pairs }, width, height) {
  const span = dist(landmarks[corners[0]], landmarks[corners[1]], width, height);
  if (!(span > 0)) return NaN;
  let gap = 0;
  for (const [a, b] of pairs) gap += dist(landmarks[a], landmarks[b], width, height);
  return gap / pairs.length / span;
}

export function eyeAspectRatio(landmarks, eye, width = 1, height = 1) {
  return aspectRatio(landmarks, { corners: eye.corners, pairs: eye.lids }, width, height);
}

export function mouthAspectRatio(landmarks, width = 1, height = 1) {
  return aspectRatio(landmarks, { corners: MOUTH.corners, pairs: MOUTH.lips }, width, height);
}

function blendshapeScore(categories, name) {
  if (!categories) return NaN;
  for (const c of categories) if (c.categoryName === name) return c.score;
  return NaN;
}

function mean2(a, b) {
  if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  return Number.isFinite(a) ? a : b;
}

/**
 * Turns one FaceLandmarker result into face metrics, or null when no face.
 * @param {{faceLandmarks?: Array, faceBlendshapes?: Array}} result
 * @param {number} width  video width in px (landmarks are normalised 0..1)
 * @param {number} height video height in px
 */
export function computeFaceMetrics(result, width, height) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks || landmarks.length < 468) return null;
  const earLeft = eyeAspectRatio(landmarks, EYES.left, width, height);
  const earRight = eyeAspectRatio(landmarks, EYES.right, width, height);
  const categories = result.faceBlendshapes?.[0]?.categories;
  const blinkLeft = blendshapeScore(categories, 'eyeBlinkLeft');
  const blinkRight = blendshapeScore(categories, 'eyeBlinkRight');
  const metrics = {
    ear: mean2(earLeft, earRight),
    earLeft,
    earRight,
    blink: mean2(blinkLeft, blinkRight),
    blinkLeft,
    blinkRight,
    mar: mouthAspectRatio(landmarks, width, height),
    jawOpen: blendshapeScore(categories, 'jawOpen'),
  };
  if (!Number.isFinite(metrics.ear) && !Number.isFinite(metrics.blink)) return null;
  return metrics;
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export const DEFAULT_BASELINE = Object.freeze({ earOpen: 0.28, blinkOpen: 0.08 });

/**
 * Collects ~2 seconds of open-eye samples and returns the person's baseline.
 * Medians ignore the odd blink during calibration.
 */
export class Calibrator {
  constructor({ durationMs = 2000, minSamples = 12 } = {}) {
    this.durationMs = durationMs;
    this.minSamples = minSamples;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.startedAt = null;
  }

  /** Adds a sample; returns progress 0..1. Frames without a face are ignored. */
  add(t, metrics) {
    if (!metrics) return this.progress(t);
    if (this.startedAt === null) this.startedAt = t;
    this.samples.push(metrics);
    return this.progress(t);
  }

  progress(t) {
    if (this.startedAt === null) return 0;
    const byTime = (t - this.startedAt) / this.durationMs;
    const bySamples = this.samples.length / this.minSamples;
    return clamp(Math.min(byTime, bySamples), 0, 1);
  }

  isDone(t) {
    return this.progress(t) >= 1;
  }

  /** @returns {{ok: boolean, baseline?: object, reason?: string}} */
  result() {
    const earOpen = median(this.samples.map((s) => s.ear));
    const blinkOpen = median(this.samples.map((s) => s.blink));
    if (Number.isFinite(blinkOpen) && blinkOpen > 0.45) return { ok: false, reason: 'eyes-closed' };
    if (Number.isFinite(earOpen) && earOpen < 0.12) return { ok: false, reason: 'eyes-closed' };
    return {
      ok: true,
      baseline: {
        earOpen: Number.isFinite(earOpen) ? clamp(earOpen, 0.15, 0.5) : DEFAULT_BASELINE.earOpen,
        blinkOpen: Number.isFinite(blinkOpen) ? clamp(blinkOpen, 0, 0.4) : DEFAULT_BASELINE.blinkOpen,
      },
    };
  }
}

/**
 * Converts metrics into a single closure value:
 * 0 = as open as during calibration, 1 = fully closed.
 */
export function closureScore(metrics, baseline = DEFAULT_BASELINE) {
  const parts = [];
  if (Number.isFinite(metrics.ear) && baseline.earOpen > 0) {
    const ratio = metrics.ear / baseline.earOpen;
    parts.push(clamp((1 - ratio) / (1 - CLOSED_EAR_RATIO), 0, 1));
  }
  if (Number.isFinite(metrics.blink)) {
    const span = Math.max(0.3, 0.85 - baseline.blinkOpen);
    parts.push(clamp((metrics.blink - baseline.blinkOpen) / span, 0, 1));
  }
  if (!parts.length) return NaN;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Sum of time-weighted values over a sliding time window. */
class TimeWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.items = [];
    this.head = 0;
    this.total = 0;
    this.hits = 0;
  }

  push(t, dt, hit) {
    this.items.push({ t, dt, hit });
    this.total += dt;
    if (hit) this.hits += dt;
    while (this.head < this.items.length && t - this.items[this.head].t > this.windowMs) {
      const old = this.items[this.head++];
      this.total -= old.dt;
      if (old.hit) this.hits -= old.dt;
    }
    if (this.head > 512) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  get ratio() {
    return this.total > 0 ? this.hits / this.total : 0;
  }
}

const countSince = (times, since) => times.reduce((n, x) => (x >= since ? n + 1 : n), 0);

/**
 * The drowsiness state machine. Feed it one frame at a time with update().
 */
export class DrowsinessMonitor {
  constructor(options = {}) {
    this.baseline = { ...DEFAULT_BASELINE };
    this.configure(options);
    this.reset();
  }

  configure({
    closedMs = this.closedMs ?? 1000, // eyes shut this long -> sleeping alarm
    alarmMs = this.alarmMs ?? 3000, // alarm length (repeats while eyes stay shut)
    sensitivity = this.sensitivity ?? 'normal',
    noFaceAlertMs = this.noFaceAlertMs ?? 0, // 0 = off
    faceLostGraceMs = this.faceLostGraceMs ?? 400,
    smoothingMs = this.smoothingMs ?? 60,
    longBlinkMs = this.longBlinkMs ?? 400, // blinks this long are a fatigue sign
    heavyEyesMs = this.heavyEyesMs ?? 4000, // drooping eyelids this long -> drowsy
    yawnMs = this.yawnMs ?? 1500, // mouth wide open this long -> yawn
    yawnEyeGraceMs = this.yawnEyeGraceMs ?? 2000, // eyes often shut mid-yawn: allow extra time
    drowsyCooldownMs = this.drowsyCooldownMs ?? 60000, // min gap between drowsy chimes
    drowsyHoldMs = this.drowsyHoldMs ?? 15000, // how long the "drowsy" level stays shown
  } = {}) {
    Object.assign(this, {
      closedMs,
      alarmMs,
      noFaceAlertMs,
      faceLostGraceMs,
      smoothingMs,
      longBlinkMs,
      heavyEyesMs,
      yawnMs,
      yawnEyeGraceMs,
      drowsyCooldownMs,
      drowsyHoldMs,
    });
    this.sensitivity = SENSITIVITY[sensitivity] ? sensitivity : 'normal';
    this.thresholds = SENSITIVITY[this.sensitivity];
  }

  setBaseline(baseline) {
    this.baseline = { ...DEFAULT_BASELINE, ...baseline };
    this.calibratedBaseline = { ...this.baseline };
  }

  reset() {
    this.closure = 0;
    this.lastT = null;
    this.closedSince = null;
    this.heavySince = null;
    this.faceSeen = false;
    this.faceLostSince = null;
    this.mouthOpenSince = null;
    this.yawnCounted = false;
    this.alarm = null; // { reason: 'eyes'|'noface', since, until }
    this.drowsy = null; // { reason, since, until }
    this.lastDrowsyWarnAt = -Infinity;
    this.perclos = new TimeWindow(60000);
    this.alerts = [];
    this.yawns = [];
    this.longBlinks = [];
    this.drowsyWarnings = [];
    this.blinks = 0;
  }

  /** Slowly follows the open-eye level so posture/lighting drift is tolerated. */
  adaptBaseline(metrics, dt) {
    const ref = this.calibratedBaseline;
    if (!ref) return;
    const a = 1 - Math.exp(-dt / 25000);
    if (Number.isFinite(metrics.ear)) {
      const next = this.baseline.earOpen + a * (metrics.ear - this.baseline.earOpen);
      // Never drift far below the calibrated value: drowsy, drooping eyelids
      // must not quietly become the new "normal".
      this.baseline.earOpen = clamp(next, ref.earOpen * 0.85, ref.earOpen * 1.3);
    }
    if (Number.isFinite(metrics.blink)) {
      const next = this.baseline.blinkOpen + a * (metrics.blink - this.baseline.blinkOpen);
      this.baseline.blinkOpen = clamp(next, Math.max(0, ref.blinkOpen - 0.1), ref.blinkOpen + 0.08);
    }
  }

  /** True while the mouth has been wide open for a moment (a yawn in progress). */
  isYawning(t) {
    return this.mouthOpenSince !== null && t - this.mouthOpenSince >= 400;
  }

  updateMouth(t, metrics, events) {
    const { jawOpen, mar } = metrics;
    const wide = jawOpen >= YAWN.jawOpen || mar >= YAWN.mar;
    const stillOpen = jawOpen >= YAWN.endJawOpen || mar >= YAWN.endMar;
    if (this.mouthOpenSince === null) {
      if (wide) this.mouthOpenSince = t;
    } else if (!stillOpen) {
      this.mouthOpenSince = null;
      this.yawnCounted = false;
    }
    if (this.mouthOpenSince !== null && !this.yawnCounted && t - this.mouthOpenSince >= this.yawnMs) {
      this.yawnCounted = true;
      this.yawns.push(t);
      events.push('yawn');
      if (countSince(this.yawns, t - 10 * 60000) >= 3) this.flagDrowsy(t, 'yawning', events);
    }
  }

  flagDrowsy(t, reason, events) {
    if (this.alarm) return;
    if (!this.drowsy) this.drowsy = { reason, since: t, until: t + this.drowsyHoldMs };
    this.drowsy.until = t + this.drowsyHoldMs;
    this.drowsy.reason = reason;
    if (t - this.lastDrowsyWarnAt >= this.drowsyCooldownMs) {
      this.lastDrowsyWarnAt = t;
      this.drowsyWarnings.push(t);
      events.push('drowsy');
    }
  }

  /**
   * Feed one camera frame.
   * @param {number} t time in ms (monotonic)
   * @param {object|null} metrics output of computeFaceMetrics, or null if no face
   * @returns snapshot of the current state plus `events` that happened now.
   */
  update(t, metrics) {
    const events = [];
    const dt = this.lastT === null ? 0 : Math.min(250, Math.max(0, t - this.lastT));
    this.lastT = t;
    const { close, open, heavy } = this.thresholds;

    if (metrics) {
      this.faceSeen = true;
      this.faceLostSince = null;
      const raw = closureScore(metrics, this.baseline);
      if (Number.isFinite(raw)) {
        const a = dt > 0 ? 1 - Math.exp(-dt / this.smoothingMs) : 1;
        this.closure += a * (raw - this.closure);
      }
      this.updateMouth(t, metrics, events);

      if (this.closedSince === null) {
        if (this.closure >= close) this.closedSince = t;
        else if (this.closure < open && !this.alarm) this.adaptBaseline(metrics, dt);
      } else if (this.closure < open) {
        const shutFor = t - this.closedSince;
        if (!this.alarm && shutFor < this.closedMs) {
          this.blinks += 1;
          events.push('blink');
          if (shutFor >= this.longBlinkMs) {
            this.longBlinks.push(t);
            events.push('long-blink');
            if (countSince(this.longBlinks, t - 60000) >= 3) this.flagDrowsy(t, 'long-blinks', events);
          }
        }
        this.closedSince = null;
      }

      if (this.closure >= heavy) {
        if (this.heavySince === null) this.heavySince = t;
      } else if (this.closure < heavy * 0.8) {
        this.heavySince = null;
      }
      this.perclos.push(t, dt, this.closure >= close);
    } else {
      if (this.faceLostSince === null) this.faceLostSince = t;
      this.heavySince = null;
      // Face vanished while the eyes were closing. If they had already been
      // shut for longer than a blink (e.g. head dropping forward), keep
      // counting; if it was just a blink before a head turn, forget it.
      if (this.closedSince !== null && !this.alarm) {
        const closedBeforeLoss = this.faceLostSince - this.closedSince;
        if (closedBeforeLoss < this.closedMs * 0.5 && t - this.faceLostSince >= this.faceLostGraceMs) {
          this.closedSince = null;
        }
      }
    }

    // Eyes often close during a big yawn: give a little extra time then.
    const limit = this.closedMs + (this.isYawning(t) ? this.yawnEyeGraceMs : 0);
    const eyesShutTooLong = this.closedSince !== null && t - this.closedSince >= limit;
    const faceGoneTooLong =
      this.noFaceAlertMs > 0 &&
      this.faceSeen &&
      this.faceLostSince !== null &&
      t - this.faceLostSince >= this.noFaceAlertMs;

    if (!this.alarm) {
      if (eyesShutTooLong || faceGoneTooLong) {
        const reason = eyesShutTooLong ? 'eyes' : 'noface';
        this.alarm = { reason, since: t, until: t + this.alarmMs };
        this.alerts.push(t);
        this.drowsy = null;
        this.lastDrowsyWarnAt = t; // the alarm says it all; no chime right after
        events.push('alarm-start');
      }
    } else if (t >= this.alarm.until) {
      const stillBad = this.alarm.reason === 'eyes' ? this.closedSince !== null : faceGoneTooLong || eyesShutTooLong;
      if (stillBad) {
        this.alarm.until = t + this.alarmMs;
        events.push('alarm-extend');
      } else {
        this.alarm = null;
        events.push('alarm-end');
      }
    }

    if (!this.alarm && metrics) {
      if (this.heavySince !== null && t - this.heavySince >= this.heavyEyesMs) this.flagDrowsy(t, 'heavy-eyes', events);
      if (this.perclos.total >= 30000 && this.perclos.ratio >= this.thresholds.perclos) {
        this.flagDrowsy(t, 'perclos', events);
      }
    }
    if (this.drowsy && t >= this.drowsy.until) this.drowsy = null;

    return this.snapshot(t, metrics, events);
  }

  /**
   * The camera was paused (app in the background, camera restarted...):
   * forget half-finished closures and yawns so stale frames can't trigger
   * anything. Counts, history and calibration are kept.
   */
  interrupt() {
    this.closedSince = null;
    this.heavySince = null;
    this.mouthOpenSince = null;
    this.yawnCounted = false;
    this.faceLostSince = null;
    this.closure = 0;
    this.lastT = null;
    this.alarm = null;
  }

  /** User tapped the alarm away: stop now and require a fresh closure. */
  dismissAlarm(t) {
    if (!this.alarm) return false;
    this.alarm = null;
    this.closedSince = null;
    if (this.faceLostSince !== null) this.faceLostSince = t;
    return true;
  }

  recentAlerts(t, windowMs = 15 * 60 * 1000) {
    return countSince(this.alerts, t - windowMs);
  }

  level() {
    if (this.alarm) return 'sleeping';
    if (this.drowsy) return 'drowsy';
    return 'active';
  }

  snapshot(t, metrics, events = []) {
    let eyes;
    if (!metrics) {
      eyes = this.closedSince !== null ? 'closed' : 'unknown';
    } else if (this.closedSince !== null) {
      eyes = t - this.closedSince >= this.closedMs ? 'closed' : 'closing';
    } else {
      eyes = 'open';
    }
    return {
      level: this.level(),
      eyes,
      face: !!metrics,
      closure: this.closure,
      closedFor: this.closedSince === null ? 0 : t - this.closedSince,
      yawning: this.isYawning(t),
      perclos: this.perclos.ratio,
      alarm: this.alarm ? { ...this.alarm } : null,
      drowsy: this.drowsy ? { ...this.drowsy } : null,
      counts: {
        alerts: this.alerts.length,
        drowsy: this.drowsyWarnings.length,
        yawns: this.yawns.length,
        blinks: this.blinks,
        longBlinks: this.longBlinks.length,
      },
      events,
    };
  }
}
