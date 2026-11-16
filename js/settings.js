// User settings, saved on this device only (localStorage).

const KEY = 'lns.settings.v1';

export const DEFAULTS = Object.freeze({
  closedSeconds: 1.0, // eyes shut this long -> loud alarm
  alarmSeconds: 3, // alarm length; it repeats while the eyes stay shut
  sensitivity: 'normal', // low | normal | high
  volume: 1.0,
  vibrate: true,
  drowsyWarnings: true, // soft chime for early fatigue signs
  yawnDetection: true,
  silentModeOverride: true, // iPhone: play the alarm even with the ring/silent switch on silent
  nightLight: 'auto', // auto | on | off
  lightLevel: 1.0, // white screen brightness: 1, 0.7, 0.4
  maxBrightness: true, // Android app: push screen brightness to 100% while the night light is on
  noFaceAlertSeconds: 0, // 0 = off
  showPreview: true,
  mirror: true,
  cameraId: '',
  useGPU: true,
  showDetails: false,
  skipPermissionPopup: false,
});

const CHOICES = {
  sensitivity: ['low', 'normal', 'high'],
  nightLight: ['auto', 'on', 'off'],
};

const RANGES = {
  closedSeconds: [0.5, 3],
  alarmSeconds: [1, 10],
  volume: [0, 1],
  lightLevel: [0.3, 1],
  noFaceAlertSeconds: [0, 30],
};

export function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (CHOICES[key]) {
      if (CHOICES[key].includes(v)) out[key] = v;
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) {
        const [lo, hi] = RANGES[key] ?? [-Infinity, Infinity];
        out[key] = Math.min(hi, Math.max(lo, n));
      }
    } else if (typeof def === 'boolean') {
      out[key] = Boolean(v);
    } else if (typeof def === 'string') {
      out[key] = String(v);
    }
  }
  return out;
}

export function loadSettings() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(settings)));
    return true;
  } catch {
    return false;
  }
}
