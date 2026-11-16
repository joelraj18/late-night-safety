// Records a drive second by second (eye openness, mouth openness, alert
// level) plus events, for the session chart and summary. Pure logic.

const LEVEL_RANK = { active: 0, drowsy: 1, sleeping: 2 };

export const EVENT_LABELS = {
  alarm: 'Sleep alarm',
  drowsy: 'Drowsy warning',
  yawn: 'Yawn',
};

export class SessionLog {
  constructor(startT = 0) {
    this.reset(startT);
  }

  reset(startT = 0) {
    this.startT = startT;
    this.points = []; // { s, eye (0..1|null), mouth (0..1|null), level }
    this.events = []; // { s, type }
    this.bucket = null;
    this.blinks = 0;
    this.faceSeconds = 0;
    this.endT = startT;
  }

  /** frame: { face: bool, closure: 0..1, mouth: 0..1|NaN, level } */
  add(t, frame) {
    this.endT = Math.max(this.endT, t);
    const s = Math.max(0, Math.floor((t - this.startT) / 1000));
    if (!this.bucket || this.bucket.s !== s) {
      this.flush();
      this.bucket = { s, frames: 0, faceFrames: 0, eye: 0, mouth: null, level: 'active' };
    }
    const b = this.bucket;
    b.frames += 1;
    if (frame.face) {
      b.faceFrames += 1;
      b.eye += 1 - frame.closure;
      if (Number.isFinite(frame.mouth)) b.mouth = Math.max(b.mouth ?? 0, frame.mouth);
    }
    if ((LEVEL_RANK[frame.level] ?? 0) > LEVEL_RANK[b.level]) b.level = frame.level;
  }

  flush() {
    const b = this.bucket;
    if (!b) return;
    const facePart = b.frames ? b.faceFrames / b.frames : 0;
    this.faceSeconds += facePart;
    this.points.push({
      s: b.s,
      eye: b.faceFrames ? Math.min(1, Math.max(0, b.eye / b.faceFrames)) : null,
      mouth: b.mouth,
      level: b.level,
    });
    this.bucket = null;
  }

  event(t, type) {
    this.events.push({ s: Math.max(0, (t - this.startT) / 1000), type });
  }

  /** Everything recorded so far, including the second in progress. */
  series() {
    const pending = this.bucket;
    if (!pending) return this.points;
    const copy = new SessionLog();
    copy.bucket = { ...pending };
    copy.flush();
    return [...this.points, ...copy.points];
  }

  summary() {
    const points = this.series();
    const durationS = Math.max(0, (this.endT - this.startT) / 1000);
    const count = (type) => this.events.filter((e) => e.type === type).length;
    const eyes = points.map((p) => p.eye).filter((v) => v !== null);
    const avgEye = eyes.length ? eyes.reduce((a, b) => a + b, 0) / eyes.length : null;
    const minutes = durationS / 60;
    return {
      durationS,
      alarms: count('alarm'),
      drowsy: count('drowsy'),
      yawns: count('yawn'),
      blinksPerMin: minutes >= 0.5 ? this.blinks / minutes : null,
      avgEyeOpenness: avgEye,
      faceVisibleShare: durationS > 0 ? Math.min(1, this.faceSeconds / durationS) : 0,
    };
  }

  /** Per-minute rows for the accessible table view. */
  minuteRows() {
    const rows = new Map();
    for (const p of this.series()) {
      const m = Math.floor(p.s / 60);
      const row = rows.get(m) ?? { minute: m, eyeSum: 0, eyeN: 0, events: [] };
      if (p.eye !== null) {
        row.eyeSum += p.eye;
        row.eyeN += 1;
      }
      rows.set(m, row);
    }
    for (const e of this.events) {
      const m = Math.floor(e.s / 60);
      const row = rows.get(m) ?? { minute: m, eyeSum: 0, eyeN: 0, events: [] };
      row.events.push(e.type);
      rows.set(m, row);
    }
    return [...rows.values()]
      .sort((a, b) => a.minute - b.minute)
      .map((r) => ({ minute: r.minute, eye: r.eyeN ? r.eyeSum / r.eyeN : null, events: r.events }));
  }
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
