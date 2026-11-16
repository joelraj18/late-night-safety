// Keeps the screen switched on while monitoring, so the phone doesn't go to
// sleep mid-drive. In order of preference:
//   1. Android app: native FLAG_KEEP_SCREEN_ON (most reliable).
//   2. Browsers: the Screen Wake Lock API (Chrome/Edge/Samsung Internet/
//      Firefox/Safari 16.4+). Released automatically when the page is hidden,
//      so it is re-requested whenever the page becomes visible again.
//   3. Older browsers: play a tiny silent video (the classic NoSleep trick).
// In the Android app it can also raise the screen brightness while the white
// night light is on (web pages can't change brightness).

import { nativePlugin } from './native.js';

// 4 s, 32x32 black H.264 video with a silent audio track (2.5 KB).
const KEEP_AWAKE_VIDEO = 'data:video/mp4;base64,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';

export class ScreenAwake {
  constructor() {
    this.wanted = false;
    this.sentinel = null;
    this.video = null;
    this.method = null; // 'native' | 'wakelock' | 'video' | null
    this.needsTap = false;
    this.listeners = new Set();
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this.acquire();
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    const status = this.status;
    for (const fn of this.listeners) fn(status);
  }

  get active() {
    if (!this.wanted) return false;
    if (this.method === 'native') return true;
    if (this.sentinel && !this.sentinel.released) return true;
    return Boolean(this.video && !this.video.paused);
  }

  get status() {
    return { active: this.active, method: this.method, needsTap: this.needsTap };
  }

  /**
   * Turn keep-awake on. Call it from the Start tap: the video fallback may
   * only start inside a user gesture.
   */
  enable() {
    this.wanted = true;
    if (nativePlugin('ScreenControl')) return this.acquire();
    if (!('wakeLock' in navigator)) {
      const started = this.startVideo(); // synchronously, inside the tap
      return Promise.resolve(started).then(() => this.active);
    }
    return this.acquire();
  }

  async acquire() {
    if (!this.wanted) return false;
    const native = nativePlugin('ScreenControl');
    if (native) {
      try {
        await native.keepAwake();
        this.method = 'native';
        this.needsTap = false;
        this.emit();
        return true;
      } catch {
        /* fall back to the web methods */
      }
    }
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      if (this.sentinel && !this.sentinel.released) return true;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (!this.wanted) {
          sentinel.release().catch(() => {});
          return false;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener('release', () => {
          if (this.sentinel === sentinel) this.sentinel = null;
          this.emit();
        });
        this.method = 'wakelock';
        this.needsTap = false;
        this.emit();
        return true;
      } catch {
        /* e.g. battery saver or a browser policy: try the video instead */
      }
    }
    const ok = await this.startVideo();
    if (!ok) this.needsTap = true;
    this.emit();
    return ok;
  }

  /** Fallback; also used by the "tap to keep screen on" button. */
  startVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.setAttribute('aria-hidden', 'true');
      v.setAttribute('title', 'Keep screen on');
      v.src = KEEP_AWAKE_VIDEO;
      v.className = 'keep-awake-video';
      // Loop by seeking: some browsers don't keep the screen on for looped media.
      v.addEventListener('timeupdate', () => {
        if (v.currentTime > 3) v.currentTime = 0.5;
      });
      document.body.append(v);
      this.video = v;
    }
    const played = this.video.play();
    return Promise.resolve(played)
      .then(() => {
        this.method = 'video';
        this.needsTap = false;
        this.emit();
        return true;
      })
      .catch(() => false);
  }

  async disable() {
    this.wanted = false;
    this.needsTap = false;
    const native = nativePlugin('ScreenControl');
    if (native) {
      try {
        await native.allowSleep();
      } catch {
        /* ignore */
      }
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel && !sentinel.released) sentinel.release().catch(() => {});
    this.video?.pause();
    this.method = null;
    this.emit();
  }

  /** Android app only: 0..1 forces a brightness, null restores the user's setting. */
  async setBrightness(value) {
    const native = nativePlugin('ScreenControl');
    if (!native) return false;
    try {
      await native.setBrightness({ value: value == null ? -1 : value });
      return true;
    } catch {
      return false;
    }
  }
}
