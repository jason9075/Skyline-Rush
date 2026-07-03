/**
 * Single-cell axis capture for the DCS-style binding grid.
 *
 * The grid decides which (command, device) pair is being assigned; this watches
 * only that one device and captures the axis that deflects furthest from its
 * neutral and is held past a threshold, with its direction, as an AxisBinding.
 * Hardware axes are assumed self-calibrated to ~[-1, 1]; an optional range is
 * added later by the per-axis calibrator.
 */

/** Deviation from neutral (0..2) required to start capturing. */
const CAPTURE_THRESHOLD = 0.5;
/** Seconds the deflection must be held before it locks in. */
const CAPTURE_HOLD = 0.6;

/**
 * @typedef {Object} AxisBinding
 * @property {number} index Gamepad index at bind time.
 * @property {string} id Gamepad id, used to re-resolve the device if indices shift.
 * @property {number} axis Axis index on that device.
 * @property {number} sign +1 or -1, so the gestured direction reads positive.
 * @property {import('./input.js').AxisRange} [range] Optional calibrated range;
 *   absent means the axis is assumed self-normalized to [-1, 1].
 */

/** Captures one axis on one device for a single grid cell. */
export class AxisCapture {
  constructor() {
    this.active = false;
    /** @type {string | null} Device id being watched. */
    this.deviceId = null;
    /** @type {Map<number, number>} Neutral value per axis, captured at start. */
    this.baseline = new Map();
    /** @type {number | null} Axis currently held for capture. */
    this.holdAxis = null;
    this.holdTime = 0;
    /** @type {((binding: AxisBinding) => void) | null} */
    this.onCapture = null;
    /** @type {((pct: number, axis: number | null) => void) | null} */
    this.onProgress = null;
  }

  /**
   * Begin capturing on one device.
   * @param {string} deviceId Gamepad id to watch.
   * @param {(binding: AxisBinding) => void} onCapture Called once an axis locks in.
   * @param {(pct: number, axis: number | null) => void} [onProgress] Hold feedback.
   */
  start(deviceId, onCapture, onProgress) {
    this.active = true;
    this.deviceId = deviceId;
    this.onCapture = onCapture;
    this.onProgress = onProgress ?? null;
    this.holdAxis = null;
    this.holdTime = 0;
    this.baseline = new Map();
    const pad = this.pad();
    if (pad) pad.axes.forEach((v, i) => this.baseline.set(i, v));
  }

  /** Stop without capturing. */
  cancel() {
    this.active = false;
    this.deviceId = null;
    this.onCapture = null;
    this.onProgress = null;
    this.holdAxis = null;
    this.holdTime = 0;
  }

  /** The watched device, re-resolved by id each frame (indices can shift). */
  pad() {
    return Array.from(navigator.getGamepads()).find((p) => p && p.id === this.deviceId) || null;
  }

  /**
   * The axis on the device that has moved furthest from its captured neutral.
   * @param {Gamepad} pad Watched device.
   * @returns {{axis: number, dev: number, delta: number} | null}
   */
  maxDeviation(pad) {
    let best = null;
    pad.axes.forEach((value, axis) => {
      const delta = value - (this.baseline.get(axis) ?? 0);
      const dev = Math.abs(delta);
      if (!best || dev > best.dev) best = { axis, dev, delta };
    });
    return best;
  }

  /**
   * Per-frame update: drive auto-capture on the watched device.
   * @param {number} dt Frame delta time in seconds.
   */
  update(dt) {
    if (!this.active) return;
    const pad = this.pad();
    if (!pad) return;
    const best = this.maxDeviation(pad);
    if (best && best.dev >= CAPTURE_THRESHOLD) {
      if (this.holdAxis === best.axis) this.holdTime += dt;
      else {
        this.holdAxis = best.axis;
        this.holdTime = 0;
      }
      if (this.holdTime >= CAPTURE_HOLD) {
        // The held direction defines +1: invert when the axis moved negative.
        const binding = {
          index: pad.index,
          id: pad.id,
          axis: best.axis,
          sign: best.delta < 0 ? -1 : 1,
        };
        const cb = this.onCapture;
        this.cancel();
        cb(binding);
        return;
      }
      if (this.onProgress) this.onProgress(Math.round((this.holdTime / CAPTURE_HOLD) * 100), best.axis);
    } else {
      this.holdAxis = null;
      this.holdTime = 0;
      if (this.onProgress) this.onProgress(0, null);
    }
  }
}
