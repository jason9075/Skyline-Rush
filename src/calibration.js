/**
 * Per-axis range calibration for a single bound cell.
 *
 * The binding grid points this at one (device, axis) already bound to a
 * command. The user sweeps that axis through its full travel, leaves it at
 * neutral, and finishes — producing the {min, center, max} range stored back
 * on the binding, so off-center or partial-travel hardware normalizes correctly
 * (see {@link import('./input.js').normalizeCentered}). HOTAS/gamepad axes that
 * already span [-1, 1] don't need this.
 */

import { padById } from './input.js';

/** Calibrates the range of one axis on one device. */
export class AxisCalibrator {
  constructor() {
    this.active = false;
    /** @type {string | null} Device id being calibrated. */
    this.deviceId = null;
    this.axis = 0;
    this.min = 0;
    this.max = 0;
    /** @type {((range: {min: number, center: number, max: number}) => void) | null} */
    this.onDone = null;
  }

  /**
   * Begin sweeping one bound axis.
   * @param {import('./axisbind.js').AxisBinding} binding Cell to calibrate.
   * @param {(range: {min: number, center: number, max: number}) => void} onDone Range sink.
   */
  start(binding, onDone) {
    this.active = true;
    this.deviceId = binding.id;
    this.axis = binding.axis;
    this.onDone = onDone;
    const v = this.value();
    this.min = v ?? 0;
    this.max = v ?? 0;
  }

  /** Stop without saving a range. */
  cancel() {
    this.active = false;
    this.deviceId = null;
    this.onDone = null;
  }

  /** The device under calibration, re-resolved by id each frame. */
  pad() {
    return padById(this.deviceId);
  }

  /** Current raw value of the calibrated axis, or null if the device is gone. */
  value() {
    const pad = this.pad();
    return pad && pad.axes[this.axis] !== undefined ? pad.axes[this.axis] : null;
  }

  /**
   * Per-frame update: widen the swept range.
   * @param {number} _dt Frame delta time in seconds (unused; sampled per frame).
   */
  update(_dt) {
    if (!this.active) return;
    const v = this.value();
    if (v === null) return;
    this.min = Math.min(this.min, v);
    this.max = Math.max(this.max, v);
  }

  /** Finish: neutral is the current rest position; range is the swept span. */
  finish() {
    if (!this.active) return;
    const center = this.value() ?? (this.min + this.max) / 2;
    const range = { min: this.min, center, max: this.max };
    const cb = this.onDone;
    this.cancel();
    if (cb) cb(range);
  }
}
