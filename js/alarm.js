// All sounds are synthesised with the Web Audio API (no audio files), so they
// work offline and can be made as harsh as an alarm needs to be.
//
//   alarm  - loud two-tone siren + low buzz, for "eyes closed" (3 s, extendable)
//   chime  - softer two-note warning, for early drowsiness signs
//
// Browsers only allow sound after the user has tapped something, so unlock()
// must be called from the Start tap. Between sounds the audio context is
// suspended: that saves battery and, on phones, doesn't interrupt music or
// navigation voice that's playing in another app.

const VIBRATE_ON = 450;
const VIBRATE_OFF = 150;

function vibrationPattern(ms) {
  const pattern = [];
  for (let total = 0; total < ms; total += VIBRATE_ON + VIBRATE_OFF) pattern.push(VIBRATE_ON, VIBRATE_OFF);
  return pattern;
}

export class AlarmSound {
  constructor() {
    this.ctx = null;
    this.volume = 1;
    this.vibrate = true;
    this.silentModeOverride = true;
    this.graph = null;
    this.cleanupTimer = null;
    this.idleTimer = null;
    this.busyUntil = 0;
    this.blocked = false;
    this.onBlockedChange = null;
  }

  get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  get playing() {
    return Boolean(this.graph);
  }

  /** Call inside a tap/click handler. Returns false if Web Audio is unavailable. */
  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    if (!this.ctx) {
      try {
        this.ctx = new Ctx({ latencyHint: 'interactive' });
      } catch {
        this.ctx = new Ctx();
      }
    }
    const ctx = this.ctx;
    // A silent sample played inside the tap unlocks audio on iOS.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    const resumed = ctx.resume ? ctx.resume() : Promise.resolve();
    resumed
      .then(() => {
        this.setBlocked(false);
        this.scheduleIdle(600);
      })
      .catch(() => {});
    return true;
  }

  setBlocked(value) {
    if (this.blocked === value) return;
    this.blocked = value;
    this.onBlockedChange?.(value);
  }

  /** Make sure the audio context is running before making a sound. */
  async wake() {
    if (!this.ctx) return false;
    clearTimeout(this.idleTimer);
    if (this.silentModeOverride && navigator.audioSession) {
      try {
        navigator.audioSession.type = 'playback'; // iPhone: audible even on silent
      } catch {
        /* ignore */
      }
    }
    if (this.ctx.state !== 'running') {
      try {
        await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 800))]);
      } catch {
        /* ignore */
      }
    }
    const ok = this.ctx.state === 'running';
    this.setBlocked(!ok);
    return ok;
  }

  scheduleIdle(delay = 1200) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.graph || performance.now() < this.busyUntil || !this.ctx) return;
      if (navigator.audioSession) {
        try {
          navigator.audioSession.type = 'auto';
        } catch {
          /* ignore */
        }
      }
      if (this.ctx.state === 'running') this.ctx.suspend?.().catch(() => {});
    }, delay);
  }

  buildAlarm(durationMs) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    const tEnd = t0 + durationMs / 1000;
    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 0;
    comp.ratio.value = 12;
    comp.attack.value = 0.002;
    comp.release.value = 0.08;
    comp.connect(master);
    master.connect(ctx.destination);

    // Piercing two-tone siren: square wave hopping between ~1.6 and ~2.6 kHz
    // eight times a second (phone speakers are loudest around 2-3 kHz).
    const siren = ctx.createOscillator();
    siren.type = 'square';
    siren.frequency.value = 2100;
    const hop = ctx.createOscillator();
    hop.type = 'square';
    hop.frequency.value = 4;
    const hopDepth = ctx.createGain();
    hopDepth.gain.value = 500;
    hop.connect(hopDepth).connect(siren.frequency);
    const sirenGain = ctx.createGain();
    sirenGain.gain.value = 0.5;
    siren.connect(sirenGain).connect(comp);

    // Rough low "buzz" underneath: two slightly detuned sawtooth waves.
    const buzzA = ctx.createOscillator();
    buzzA.type = 'sawtooth';
    buzzA.frequency.value = 150;
    const buzzB = ctx.createOscillator();
    buzzB.type = 'sawtooth';
    buzzB.frequency.value = 157;
    const buzzGain = ctx.createGain();
    buzzGain.gain.value = 0.32;
    buzzA.connect(buzzGain);
    buzzB.connect(buzzGain);
    buzzGain.connect(comp);

    const oscs = [siren, hop, buzzA, buzzB];
    const graph = { master, comp, oscs, nodes: [sirenGain, buzzGain, hopDepth], tEnd };
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(this.volume, t0 + 0.02);
    this.envelopeEnd(graph, tEnd);
    for (const o of oscs) {
      o.start(t0);
      o.stop(tEnd + 0.05);
    }
    return graph;
  }

  envelopeEnd(graph, tEnd) {
    const g = graph.master.gain;
    g.setValueAtTime(this.volume, Math.max(this.ctx.currentTime, tEnd - 0.06));
    g.linearRampToValueAtTime(0, tEnd);
  }

  teardown(graph) {
    if (!graph) return;
    for (const node of [...graph.oscs, ...graph.nodes, graph.comp, graph.master]) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  scheduleCleanup(graph, durationMs) {
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = setTimeout(() => {
      if (this.graph !== graph) return;
      this.teardown(graph);
      this.graph = null;
      this.scheduleIdle();
    }, durationMs + 250);
  }

  /** Start the loud alarm for durationMs (or extend it if it's already sounding). */
  async start(durationMs = 3000) {
    if (this.vibrate) navigator.vibrate?.(vibrationPattern(durationMs));
    if (this.graph) return this.extend(durationMs);
    if (!(await this.wake())) return false;
    if (this.graph) return this.extend(durationMs); // started while we were waiting
    this.graph = this.buildAlarm(durationMs);
    this.scheduleCleanup(this.graph, durationMs);
    return true;
  }

  extend(durationMs = 3000) {
    const graph = this.graph;
    if (!graph) return this.start(durationMs);
    if (this.vibrate) navigator.vibrate?.(vibrationPattern(durationMs));
    const now = this.ctx.currentTime;
    const tEnd = now + durationMs / 1000;
    try {
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setValueAtTime(this.volume, now);
      this.envelopeEnd(graph, tEnd);
      for (const o of graph.oscs) o.stop(tEnd + 0.05);
      graph.tEnd = tEnd;
      this.scheduleCleanup(graph, durationMs);
    } catch {
      // Some older browsers refuse a second stop(): rebuild seamlessly.
      this.teardown(graph);
      this.graph = this.buildAlarm(durationMs);
      this.scheduleCleanup(this.graph, durationMs);
    }
    return true;
  }

  stop() {
    navigator.vibrate?.(0);
    const graph = this.graph;
    if (!graph) return;
    this.graph = null;
    clearTimeout(this.cleanupTimer);
    try {
      const now = this.ctx.currentTime;
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setValueAtTime(graph.master.gain.value, now);
      graph.master.gain.linearRampToValueAtTime(0, now + 0.04);
      for (const o of graph.oscs) o.stop(now + 0.06);
    } catch {
      /* ignore */
    }
    setTimeout(() => this.teardown(graph), 150);
    this.scheduleIdle();
  }

  /** Softer two-note warning for early signs of drowsiness. */
  async chime() {
    if (this.vibrate) navigator.vibrate?.([180, 120, 180]);
    if (!(await this.wake())) return false;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0.7 * this.volume;
    out.connect(ctx.destination);
    const notes = [
      { f: 1046.5, at: 0 },
      { f: 784, at: 0.28 },
      { f: 1046.5, at: 0.56 },
    ];
    for (const { f, at } of notes) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(1, t0 + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.26);
      o.connect(g).connect(out);
      o.start(t0 + at);
      o.stop(t0 + at + 0.28);
    }
    this.busyUntil = performance.now() + 1000;
    setTimeout(() => {
      try {
        out.disconnect();
      } catch {
        /* ignore */
      }
      this.scheduleIdle();
    }, 1100);
    return true;
  }
}
