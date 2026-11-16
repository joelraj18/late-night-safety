// Decides when to turn the screen into a white "night light" that lights up
// the driver's face so the camera can still see the eyes in the dark.
// Pure logic (no DOM), unit tested in tests/unit.
//
// Modes:
//   'auto' - turns on when the face can't be seen and the picture is dark
//            (or the face has been missing for a few seconds). Once on, it
//            stays on: the face is probably only visible *because* of the
//            light, so switching it off would just lose the face again.
//   'on'   - always on while monitoring.
//   'off'  - never.

export class NightLightController {
  constructor({
    mode = 'auto',
    darkLuma = 70, // average brightness (0-255) below which the picture counts as dark
    veryDarkLuma = 30,
    darkNoFaceMs = 800, // dark + no face for this long -> light on
    noFaceMs = 3000, // no face for this long (any brightness) -> light on
    veryDarkMs = 1500, // picture nearly black for this long, even with a face -> light on
  } = {}) {
    Object.assign(this, { darkLuma, veryDarkLuma, darkNoFaceMs, noFaceMs, veryDarkMs });
    this.mode = mode;
    this.reset();
  }

  reset() {
    this.on = this.mode === 'on';
    this.reason = this.on ? 'manual' : null;
    this.noFaceSince = null;
    this.veryDarkSince = null;
    this.snoozed = false;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.snoozed = false;
    this.on = mode === 'on';
    this.reason = this.on ? 'manual' : null;
  }

  /** User switched the light off by hand (auto mode): stay off until the face is seen again. */
  snooze() {
    this.snoozed = true;
    this.on = false;
    this.reason = null;
    this.noFaceSince = null;
    this.veryDarkSince = null;
  }

  /** User switched the light on by hand. */
  wake() {
    this.snoozed = false;
    this.on = true;
    this.reason = 'manual';
  }

  /**
   * @param {number} t time in ms
   * @param {{faceVisible: boolean, luma: number|null}} frame
   * @returns {{on: boolean, reason: string|null, changed: boolean}}
   */
  update(t, { faceVisible, luma }) {
    const before = this.on;
    if (this.mode === 'on') {
      this.on = true;
    } else if (this.mode === 'off') {
      this.on = false;
    } else if (!this.on) {
      if (faceVisible) {
        this.snoozed = false;
        this.noFaceSince = null;
      } else if (this.noFaceSince === null) {
        this.noFaceSince = t;
      }
      const hasLuma = Number.isFinite(luma);
      const dark = hasLuma && luma < this.darkLuma;
      const veryDark = hasLuma && luma < this.veryDarkLuma;
      if (veryDark) {
        if (this.veryDarkSince === null) this.veryDarkSince = t;
      } else {
        this.veryDarkSince = null;
      }

      if (!this.snoozed) {
        const missingFor = this.noFaceSince === null ? 0 : t - this.noFaceSince;
        if (this.noFaceSince !== null && dark && missingFor >= this.darkNoFaceMs) {
          this.turnOn('dark');
        } else if (this.noFaceSince !== null && missingFor >= this.noFaceMs) {
          this.turnOn('no-face');
        } else if (this.veryDarkSince !== null && t - this.veryDarkSince >= this.veryDarkMs) {
          this.turnOn('dark');
        }
      }
    }
    return { on: this.on, reason: this.reason, changed: before !== this.on };
  }

  turnOn(reason) {
    this.on = true;
    this.reason = reason;
  }
}
