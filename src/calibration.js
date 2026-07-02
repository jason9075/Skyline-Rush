/**
 * Controller calibration wizard.
 *
 * Flow:
 *   1. range   — sweep both sticks; min/max recorded per axis continuously.
 *   2. center  — release sticks; neutral captured on Next.
 *   3. assign  — for throttle/yaw/pitch/roll in turn, hold the stick at the
 *                indicated extreme; the deflected axis (and its direction) is
 *                auto-captured after a short hold, then the wizard waits for
 *                neutral before the next channel.
 *   4. done    — calibration saved via InputManager.setCalibration().
 */

import { normalizeCentered } from './input.js';

/** Deflection (0..1) required to auto-capture a channel. */
const CAPTURE_THRESHOLD = 0.7;
/** Seconds the deflection must be held before capture. */
const CAPTURE_HOLD = 0.6;
/** All axes must fall below this deflection before the next assign step. */
const NEUTRAL_THRESHOLD = 0.3;

/** Channel assignment order and the gesture asked of the user. */
const ASSIGN_STEPS = [
  { channel: 'throttle', gesture: 'Move the THROTTLE stick fully UP and hold' },
  { channel: 'yaw', gesture: 'Move the YAW stick fully RIGHT and hold' },
  { channel: 'pitch', gesture: 'Move the PITCH stick fully FORWARD and hold' },
  { channel: 'roll', gesture: 'Move the ROLL stick fully RIGHT and hold' },
];

/** Wizard state machine driving the calibration overlay. */
export class CalibrationWizard {
  /**
   * @param {import('./input.js').InputManager} input Input manager to read from and save to.
   * @param {{
   *   overlay: HTMLElement,
   *   instruction: HTMLElement,
   *   axesContainer: HTMLElement,
   *   status: HTMLElement,
   *   nextButton: HTMLButtonElement,
   * }} dom Calibration overlay elements.
   * @param {() => void} onClose Called when the wizard closes (finished or cancelled).
   */
  constructor(input, dom, onClose) {
    this.input = input;
    this.dom = dom;
    this.onClose = onClose;
    this.active = false;
    /** @type {'range' | 'center' | 'assign' | 'wait-neutral' | 'done'} */
    this.step = 'range';
    this.assignIndex = 0;
    this.holdTime = 0;
    /** @type {number | null} */
    this.holdAxis = null;
    /** @type {import('./input.js').AxisRange[]} */
    this.axes = [];
    /** @type {Record<string, {axis: number, invert: boolean}>} */
    this.mapping = {};
    /** @type {HTMLElement[]} */
    this.bars = [];
  }

  /** Open the overlay and start from the range-sweep step. */
  start() {
    this.active = true;
    this.step = 'range';
    this.assignIndex = 0;
    this.holdTime = 0;
    this.holdAxis = null;
    this.axes = [];
    this.mapping = {};
    this.dom.overlay.hidden = false;
    this.buildBars();
    this.render();
  }

  /** Close the overlay without saving. */
  cancel() {
    this.active = false;
    this.dom.overlay.hidden = true;
    this.onClose();
  }

  /** Advance manual steps (range → center → assign; done → close). */
  next() {
    if (this.step === 'range') {
      this.step = 'center';
    } else if (this.step === 'center') {
      const raw = this.input.rawAxes();
      raw.forEach((value, i) => {
        if (this.axes[i]) this.axes[i].center = value;
      });
      this.step = 'assign';
    } else if (this.step === 'done') {
      this.input.setCalibration({ axes: this.axes, mapping: this.mapping });
      this.active = false;
      this.dom.overlay.hidden = true;
      this.onClose();
      return;
    }
    this.render();
  }

  /** Create one live bar per gamepad axis. */
  buildBars() {
    this.dom.axesContainer.innerHTML = '';
    this.bars = [];
    const count = this.input.rawAxes().length;
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'calib-axis';
      const label = document.createElement('span');
      label.textContent = `A${i}`;
      const track = document.createElement('div');
      track.className = 'calib-track';
      const fill = document.createElement('div');
      fill.className = 'calib-fill';
      track.appendChild(fill);
      row.append(label, track);
      this.dom.axesContainer.appendChild(row);
      this.bars.push(fill);
    }
  }

  /**
   * Per-frame update: record ranges, drive auto-capture, refresh bars.
   * @param {number} dt Frame delta time in seconds.
   */
  update(dt) {
    if (!this.active) return;
    const raw = this.input.rawAxes();
    if (raw.length === 0) {
      this.dom.instruction.textContent =
        'No controller detected. Connect it via USB and move a stick.';
      return;
    }
    if (this.bars.length !== raw.length) this.buildBars();

    // Range sweep runs during every step so late extremes still count.
    raw.forEach((value, i) => {
      if (!this.axes[i]) this.axes[i] = { min: value, center: 0, max: value };
      this.axes[i].min = Math.min(this.axes[i].min, value);
      this.axes[i].max = Math.max(this.axes[i].max, value);
    });

    if (this.step === 'assign') this.updateAssign(raw, dt);
    if (this.step === 'wait-neutral' && this.centeredAxesNeutral(raw)) {
      this.step = this.assignIndex < ASSIGN_STEPS.length ? 'assign' : 'done';
      this.render();
    }
    this.renderBars(raw);
  }

  /**
   * True once every self-centering axis has sprung back to neutral — the gate
   * that must clear before the next axis is captured, so a stick still held
   * (or overshooting) from the previous gesture can't be grabbed as the next
   * channel. Unlike {@link maxDeflection} this checks *assigned* centered axes
   * too (yaw/pitch/roll must physically return), but skips the throttle axis:
   * throttle rests wherever it's left instead of centering, so requiring it at
   * neutral would stall the wizard forever.
   * @param {number[]} raw Raw axis values.
   * @returns {boolean}
   */
  centeredAxesNeutral(raw) {
    const throttleAxis = this.mapping.throttle ? this.mapping.throttle.axis : -1;
    for (let i = 0; i < raw.length; i++) {
      if (i === throttleAxis || !this.axes[i]) continue;
      if (Math.abs(normalizeCentered(this.axes[i], raw[i])) >= NEUTRAL_THRESHOLD) return false;
    }
    return true;
  }

  /**
   * Find the most deflected unassigned axis.
   * @param {number[]} raw Raw axis values.
   * @returns {{axis: number, deflection: number, value: number}}
   */
  maxDeflection(raw) {
    const assigned = new Set(Object.values(this.mapping).map((m) => m.axis));
    let best = { axis: -1, deflection: 0, value: 0 };
    raw.forEach((value, i) => {
      if (assigned.has(i)) return;
      const deflection = Math.abs(normalizeCentered(this.axes[i], value));
      if (deflection > best.deflection) best = { axis: i, deflection, value };
    });
    return best;
  }

  /**
   * Auto-capture the deflected axis once held past the threshold.
   * @param {number[]} raw Raw axis values.
   * @param {number} dt Frame delta time in seconds.
   */
  updateAssign(raw, dt) {
    const best = this.maxDeflection(raw);
    if (best.deflection >= CAPTURE_THRESHOLD) {
      if (this.holdAxis === best.axis) {
        this.holdTime += dt;
      } else {
        this.holdAxis = best.axis;
        this.holdTime = 0;
      }
      if (this.holdTime >= CAPTURE_HOLD) {
        const { channel } = ASSIGN_STEPS[this.assignIndex];
        // The gesture position defines +1: invert when the raw signal reads negative there.
        this.mapping[channel] = {
          axis: best.axis,
          invert: normalizeCentered(this.axes[best.axis], best.value) < 0,
        };
        this.assignIndex += 1;
        this.holdAxis = null;
        this.holdTime = 0;
        this.step = 'wait-neutral';
        this.render();
      }
    } else {
      this.holdAxis = null;
      this.holdTime = 0;
    }
    const progress = Math.min(1, this.holdTime / CAPTURE_HOLD);
    if (this.step === 'assign' && progress > 0) {
      this.dom.status.textContent = `Capturing A${this.holdAxis}... ${Math.round(progress * 100)}%`;
    }
  }

  /**
   * Map the live sticks through the calibration captured SO FAR, so the stick
   * HUD can preview the in-progress result (correct axes AND direction) before
   * the user commits with Save & Finish. Without this the HUD would keep using
   * the previously-active channel map, whose axes don't match this controller.
   * @returns {import('./input.js').ControlInput}
   */
  previewControls() {
    return this.input.calibratedControls(
      { axes: this.axes, mapping: this.mapping },
      this.input.rawAxes()
    );
  }

  /** Refresh instruction text and button states for the current step. */
  render() {
    const d = this.dom;
    d.status.textContent = '';
    d.nextButton.hidden = false;
    if (this.step === 'range') {
      d.instruction.textContent =
        'Step 1/3 — Move both sticks through their FULL range a few times, then click Next.';
      d.nextButton.textContent = 'Next';
    } else if (this.step === 'center') {
      d.instruction.textContent =
        'Step 2/3 — Release the sticks so they sit at neutral, then click Next to capture center.';
      d.nextButton.textContent = 'Capture Center';
    } else if (this.step === 'assign') {
      const { gesture } = ASSIGN_STEPS[this.assignIndex];
      d.instruction.textContent =
        `Step 3/3 (${this.assignIndex + 1}/${ASSIGN_STEPS.length}) — ${gesture}.`;
      d.nextButton.hidden = true;
    } else if (this.step === 'wait-neutral') {
      const next = ASSIGN_STEPS[this.assignIndex];
      d.instruction.textContent = next
        ? 'Captured. Release ALL sticks to center — the next step starts once they rest at neutral.'
        : 'Captured. Release ALL sticks to center to finish.';
      d.nextButton.hidden = true;
    } else if (this.step === 'done') {
      const summary = ASSIGN_STEPS
        .map(({ channel }) => `${channel}: A${this.mapping[channel].axis}${this.mapping[channel].invert ? ' (inverted)' : ''}`)
        .join(', ');
      d.instruction.textContent = 'Calibration complete.';
      d.status.textContent = summary;
      d.nextButton.textContent = 'Save & Finish';
    }
  }

  /**
   * Draw the live axis bars; assigned axes are tinted green.
   * @param {number[]} raw Raw axis values.
   */
  renderBars(raw) {
    const assigned = new Map(
      Object.entries(this.mapping).map(([channel, m]) => [m.axis, channel])
    );
    raw.forEach((value, i) => {
      const fill = this.bars[i];
      if (!fill) return;
      const pct = (Math.max(-1, Math.min(1, value)) + 1) / 2;
      fill.style.width = `${pct * 100}%`;
      fill.classList.toggle('assigned', assigned.has(i));
    });
  }
}
