/**
 * Multi-device axis binder (DCS-style).
 *
 * Binds throttle / yaw / pitch / roll each to an axis on ANY connected
 * device, so split HOTAS or dual-stick rigs work — e.g. throttle + yaw on one
 * stick, pitch + roll on another. Independent of the single-device calibration
 * wizard.
 *
 * Flow:
 *   1. baseline     — center everything; neutral value captured per axis, per device.
 *   2. assign       — for each channel, push its axis to the max and hold; the
 *                     axis (across all devices) that moved most is auto-captured.
 *   3. wait-neutral — release before the next channel.
 *   4. done         — bindings saved via InputManager.setBindings().
 *
 * Hardware axes are assumed self-calibrated to ~[-1, 1] (true of HOTAS gear),
 * so only device, axis index, and direction are captured — no range sweep.
 */

/** Deviation from neutral (0..2) required to start capturing a channel. */
const CAPTURE_THRESHOLD = 0.5;
/** Seconds the deflection must be held before it locks in. */
const CAPTURE_HOLD = 0.6;
/** All axes must settle below this deviation before the next channel. */
const NEUTRAL_THRESHOLD = 0.25;

/** Channel bind order and the gesture asked of the user. */
const BIND_STEPS = [
  { channel: 'throttle', gesture: 'Push the THROTTLE axis to its MAX (full up) and hold' },
  { channel: 'yaw', gesture: 'Turn YAW fully RIGHT and hold' },
  { channel: 'pitch', gesture: 'Push PITCH fully FORWARD and hold' },
  { channel: 'roll', gesture: 'Roll fully RIGHT and hold' },
];

/**
 * @typedef {Object} AxisBinding
 * @property {number} index Gamepad index at bind time.
 * @property {string} id Gamepad id, used to re-resolve the device if indices shift.
 * @property {number} axis Axis index on that device.
 * @property {number} sign +1 or -1, so the gestured direction reads positive.
 */

/** State machine driving the multi-device binding overlay. */
export class AxisBinder {
  /**
   * @param {import('./input.js').InputManager} input Input manager to save to.
   * @param {{
   *   overlay: HTMLElement,
   *   instruction: HTMLElement,
   *   status: HTMLElement,
   *   nextButton: HTMLButtonElement,
   * }} dom Binding overlay elements.
   * @param {() => void} onClose Called when the binder closes (finished or cancelled).
   */
  constructor(input, dom, onClose) {
    this.input = input;
    this.dom = dom;
    this.onClose = onClose;
    this.active = false;
    /** @type {'baseline' | 'assign' | 'wait-neutral' | 'done'} */
    this.step = 'baseline';
    this.index = 0;
    /** @type {string | null} Axis key currently being held for capture. */
    this.holdKey = null;
    this.holdTime = 0;
    /** @type {Map<string, number>} Neutral value per `${deviceIndex}:${axis}`. */
    this.baseline = new Map();
    /** @type {Record<string, AxisBinding>} */
    this.bindings = {};
  }

  /** Open the overlay and start from the neutral-capture step. */
  start() {
    this.active = true;
    this.step = 'baseline';
    this.index = 0;
    this.holdKey = null;
    this.holdTime = 0;
    this.baseline = new Map();
    this.bindings = {};
    this.dom.overlay.hidden = false;
    this.render();
  }

  /** Close the overlay without saving. */
  cancel() {
    this.active = false;
    this.dom.overlay.hidden = true;
    this.onClose();
  }

  /** Advance manual steps (baseline → assign; done → save & close). */
  next() {
    if (this.step === 'baseline') {
      this.captureBaseline();
      this.step = 'assign';
    } else if (this.step === 'done') {
      this.input.setBindings(this.bindings);
      this.active = false;
      this.dom.overlay.hidden = true;
      this.onClose();
      return;
    }
    this.render();
  }

  /**
   * Flatten every axis of every connected pad.
   * @returns {{index: number, id: string, axis: number, value: number, key: string}[]}
   */
  scan() {
    const out = [];
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      pad.axes.forEach((value, axis) => {
        out.push({ index: pad.index, id: pad.id, axis, value, key: `${pad.index}:${axis}` });
      });
    }
    return out;
  }

  /** Snapshot the neutral value of every axis across every device. */
  captureBaseline() {
    this.baseline = new Map();
    for (const a of this.scan()) this.baseline.set(a.key, a.value);
  }

  /**
   * The axis (across all devices) that has moved furthest from its neutral,
   * excluding already-bound axes.
   * @returns {{index: number, id: string, axis: number, key: string, dev: number, delta: number} | null}
   */
  maxDeviation() {
    const used = new Set(Object.values(this.bindings).map((b) => `${b.index}:${b.axis}`));
    let best = null;
    for (const a of this.scan()) {
      if (used.has(a.key)) continue;
      const delta = a.value - (this.baseline.get(a.key) ?? 0);
      const dev = Math.abs(delta);
      if (!best || dev > best.dev) best = { index: a.index, id: a.id, axis: a.axis, key: a.key, dev, delta };
    }
    return best;
  }

  /**
   * Per-frame update: drive auto-capture and step transitions.
   * @param {number} dt Frame delta time in seconds.
   */
  update(dt) {
    if (!this.active) return;
    if (this.scan().length === 0) {
      this.dom.instruction.textContent =
        'No controllers detected. Connect them, move an axis on each to wake them, then retry.';
      return;
    }
    if (this.step === 'assign') {
      this.updateAssign(dt);
    } else if (this.step === 'wait-neutral') {
      const best = this.maxDeviation();
      if (!best || best.dev < NEUTRAL_THRESHOLD) {
        this.step = this.index < BIND_STEPS.length ? 'assign' : 'done';
        this.render();
      }
    }
  }

  /**
   * Auto-capture the deflected axis once held past the threshold.
   * @param {number} dt Frame delta time in seconds.
   */
  updateAssign(dt) {
    const best = this.maxDeviation();
    if (best && best.dev >= CAPTURE_THRESHOLD) {
      if (this.holdKey === best.key) this.holdTime += dt;
      else {
        this.holdKey = best.key;
        this.holdTime = 0;
      }
      if (this.holdTime >= CAPTURE_HOLD) {
        const { channel } = BIND_STEPS[this.index];
        // The held direction defines +1: invert when the axis moved negative.
        this.bindings[channel] = {
          index: best.index,
          id: best.id,
          axis: best.axis,
          sign: best.delta < 0 ? -1 : 1,
        };
        this.index += 1;
        this.holdKey = null;
        this.holdTime = 0;
        this.step = 'wait-neutral';
        this.render();
        return;
      }
      const pct = Math.round((this.holdTime / CAPTURE_HOLD) * 100);
      this.dom.status.textContent = `Detected device ${best.index} · axis ${best.axis} — hold… ${pct}%`;
    } else {
      this.holdKey = null;
      this.holdTime = 0;
      this.dom.status.textContent = 'Move only the axis you want to bind.';
    }
  }

  /** Refresh instruction text and button state for the current step. */
  render() {
    const d = this.dom;
    d.nextButton.hidden = false;
    d.status.textContent = '';
    if (this.step === 'baseline') {
      d.instruction.textContent =
        'Center all sticks and lower the throttle, then click below to capture neutral across every device.';
      d.nextButton.textContent = 'Capture Neutral';
    } else if (this.step === 'assign') {
      const { gesture } = BIND_STEPS[this.index];
      d.instruction.textContent = `(${this.index + 1}/${BIND_STEPS.length}) ${gesture}.`;
      d.nextButton.hidden = true;
    } else if (this.step === 'wait-neutral') {
      d.instruction.textContent = 'Captured. Release everything back to neutral…';
      d.nextButton.hidden = true;
    } else if (this.step === 'done') {
      d.instruction.textContent = 'All axes bound.';
      d.status.textContent = BIND_STEPS.map(({ channel }) => {
        const b = this.bindings[channel];
        return `${channel}: dev${b.index}/A${b.axis}${b.sign < 0 ? ' inv' : ''}`;
      }).join('  ·  ');
      d.nextButton.textContent = 'Save & Finish';
    }
  }
}
