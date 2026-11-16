import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NightLightController } from '../../js/night-light.js';

const STEP = 100;

function run(light, t0, t1, frameAt) {
  let state;
  const changes = [];
  for (let t = t0; t < t1; t += STEP) {
    state = light.update(t, frameAt(t));
    if (state.changed) changes.push({ t, on: state.on, reason: state.reason });
  }
  return { state, changes };
}

test('auto: dark and no face -> white screen within a second', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 3000, () => ({ faceVisible: false, luma: 12 }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].on, true);
  assert.equal(changes[0].reason, 'dark');
  assert.ok(changes[0].t >= 800 && changes[0].t <= 900);
});

test('auto: stays on once the light makes the face visible (no flicker)', () => {
  const light = new NightLightController();
  run(light, 0, 2000, () => ({ faceVisible: false, luma: 10 }));
  assert.equal(light.on, true);
  // The white screen lights the face up: face visible, picture brighter.
  const { changes } = run(light, 2000, 60000, () => ({ faceVisible: true, luma: 140 }));
  assert.equal(changes.length, 0);
  assert.equal(light.on, true);
});

test('auto: bright room with the face in view keeps the light off', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 30000, () => ({ faceVisible: true, luma: 120 }));
  assert.equal(changes.length, 0);
  assert.equal(light.on, false);
});

test('auto: a quick look away in daylight does not turn it on', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 10000, (t) => ({ faceVisible: !(t > 2000 && t < 3500), luma: 130 }));
  assert.equal(changes.length, 0);
});

test('auto: face missing for 3 s turns it on even if the picture is not dark (backlit face)', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 5000, () => ({ faceVisible: false, luma: 110 }));
  assert.equal(changes[0]?.reason, 'no-face');
  assert.ok(changes[0].t >= 3000 && changes[0].t <= 3100);
});

test('auto: very dark picture turns it on even while the face is still found', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 4000, () => ({ faceVisible: true, luma: 18 }));
  assert.equal(changes[0]?.reason, 'dark');
  assert.ok(changes[0].t >= 1500 && changes[0].t <= 1600);
});

test('snooze: user turns it off; it stays off until the face has been seen again', () => {
  const light = new NightLightController();
  run(light, 0, 2000, () => ({ faceVisible: false, luma: 10 }));
  light.snooze();
  let r = run(light, 2000, 20000, () => ({ faceVisible: false, luma: 10 }));
  assert.equal(r.changes.length, 0, 'still dark, still no face: respect the user');
  // Face comes back (e.g. dawn), then is lost again in the dark: auto works again.
  run(light, 20000, 21000, () => ({ faceVisible: true, luma: 90 }));
  r = run(light, 21000, 23000, () => ({ faceVisible: false, luma: 10 }));
  assert.equal(r.changes[0]?.on, true);
});

test('modes: on and off override auto', () => {
  const light = new NightLightController({ mode: 'on' });
  assert.equal(light.update(0, { faceVisible: true, luma: 200 }).on, true);
  light.setMode('off');
  assert.equal(run(light, 0, 10000, () => ({ faceVisible: false, luma: 0 })).state.on, false);
  light.setMode('auto');
  assert.equal(run(light, 10000, 12000, () => ({ faceVisible: false, luma: 0 })).state.on, true);
});

test('missing brightness reading only uses the no-face rule', () => {
  const light = new NightLightController();
  const { changes } = run(light, 0, 5000, () => ({ faceVisible: false, luma: null }));
  assert.equal(changes[0]?.reason, 'no-face');
});
