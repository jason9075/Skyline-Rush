/**
 * Input handling: RadioMaster RC controller via the Gamepad API,
 * with a keyboard fallback for development without hardware.
 *
 * Normalized output convention:
 *   throttle: 0..1   (0 = idle, 1 = full thrust)
 *   yaw:     -1..1   (positive = yaw right)
 *   pitch:   -1..1   (positive = nose forward)
 *   roll:    -1..1   (positive = bank right)
 */

/** Stick deadband applied to yaw/pitch/roll axes. */
const DEADBAND = 0.04;

/**
 * Axis index layouts for common RC channel orders.
 * RadioMaster (EdgeTX) in USB Joystick mode exposes channels as gamepad axes
 * in mixer order — AETR is the EdgeTX default, TAER is common on Betaflight-style setups.
 * @type {Record<string, {roll: number, pitch: number, throttle: number, yaw: number}>}
 */
const CHANNEL_MAPS = {
  AETR: { roll: 0, pitch: 1, throttle: 2, yaw: 3 },
  TAER: { throttle: 0, roll: 1, pitch: 2, yaw: 3 },
};

/** localStorage key for persisted calibration data. */
const CALIBRATION_KEY = 'drone-control.calibration';

/**
 * @typedef {Object} AxisRange
 * @property {number} min Raw minimum seen during calibration.
 * @property {number} center Raw neutral position.
 * @property {number} max Raw maximum seen during calibration.
 */

/**
 * @typedef {Object} Calibration
 * @property {AxisRange[]} axes Per-axis raw ranges.
 * @property {Record<'throttle'|'yaw'|'pitch'|'roll', {axis: number, invert: boolean}>} mapping
 */

/**
 * Normalize a raw axis value against its calibrated range, centered at
 * neutral: returns -1..1 with 0 at the calibrated center.
 * @param {AxisRange} range Calibrated range.
 * @param {number} raw Raw axis value.
 * @returns {number}
 */
export function normalizeCentered(range, raw) {
  const span = raw >= range.center ? range.max - range.center : range.center - range.min;
  if (span < 1e-6) return 0;
  return Math.max(-1, Math.min(1, (raw - range.center) / span));
}

/**
 * @typedef {Object} ControlInput
 * @property {number} throttle 0..1
 * @property {number} yaw -1..1
 * @property {number} pitch -1..1
 * @property {number} roll -1..1
 */

/**
 * Apply a symmetric deadband and clamp to [-1, 1].
 * @param {number} value Raw axis value.
 * @returns {number}
 */
function shapeAxis(value) {
  if (Math.abs(value) < DEADBAND) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Cubic expo (Betaflight-style): softens response around center while
 * preserving full deflection at the endpoints. expo 0 = linear.
 * @param {number} value Input in [-1, 1].
 * @param {number} expo Expo amount in [0, 1].
 * @returns {number}
 */
export function expoCurve(value, expo) {
  return value * (1 - expo) + value ** 3 * expo;
}

/** Polls gamepads and keyboard, exposing one normalized ControlInput per frame. */
export class InputManager {
  /**
   * @param {(status: string) => void} onStatusChange Called when the active input source changes.
   */
  constructor(onStatusChange) {
    /** @type {string} */
    this.channelMap = 'AETR';
    /** @type {Calibration | null} */
    this.calibration = InputManager.loadCalibration();
    if (this.calibration) this.channelMap = 'CUSTOM';
    /** @type {number | null} */
    this.gamepadIndex = null;
    /** @type {(status: string) => void} */
    this.onStatusChange = onStatusChange;
    /** @type {Set<string>} */
    this.keys = new Set();
    /** Keyboard throttle is stateful so W/S nudge it up and down. */
    this.keyboardThrottle = 0;
    /** Expo amounts in [0, 1] applied to the centered channels. */
    this.rates = { expo: 0, yawExpo: 0 };

    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.onStatusChange(`Gamepad: ${e.gamepad.id}`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.gamepadIndex) {
        this.gamepadIndex = null;
        this.onStatusChange('Gamepad: none (keyboard fallback active)');
      }
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  /**
   * Read the active gamepad, if any. Falls back to scanning
   * `navigator.getGamepads()` when no 'gamepadconnected' event has arrived
   * yet — some browsers only fire that event after the very first button
   * press or stick movement on the device, so a pad plugged in before the
   * page (or before it's been touched) would otherwise never be picked up.
   * @returns {Gamepad | null}
   */
  activeGamepad() {
    if (this.gamepadIndex === null) {
      const pad = Array.from(navigator.getGamepads()).find((p) => p);
      if (!pad) return null;
      this.gamepadIndex = pad.index;
      this.onStatusChange(`Gamepad: ${pad.id}`);
      return pad;
    }
    // getGamepads() must be re-polled every frame; state objects are snapshots.
    return navigator.getGamepads()[this.gamepadIndex] ?? null;
  }

  /**
   * Poll the current control input.
   * @param {number} dt Frame delta time in seconds (used by the keyboard throttle ramp).
   * @returns {ControlInput}
   */
  poll(dt) {
    return this.applyRates(this.pollRaw(dt));
  }

  /**
   * Poll input before the rate/expo shaping.
   * @param {number} dt Frame delta time in seconds.
   * @returns {ControlInput}
   */
  pollRaw(dt) {
    const pad = this.activeGamepad();
    if (pad && pad.axes.length >= 4) {
      if (this.channelMap === 'CUSTOM' && this.calibration) {
        return this.pollCalibrated(pad);
      }
      const map = CHANNEL_MAPS[this.channelMap] ?? CHANNEL_MAPS.AETR;
      return {
        // RC throttle axis: -1 = stick down (idle), +1 = stick up (full).
        throttle: Math.max(0, Math.min(1, (pad.axes[map.throttle] + 1) / 2)),
        yaw: shapeAxis(pad.axes[map.yaw]),
        // HID convention: pushing a stick forward reads negative — flip to "forward = +1".
        pitch: shapeAxis(-pad.axes[map.pitch]),
        roll: shapeAxis(pad.axes[map.roll]),
      };
    }
    return this.pollKeyboard(dt);
  }

  /**
   * Run the centered channels through the configured expo curves.
   * @param {ControlInput} raw Unshaped input.
   * @returns {ControlInput}
   */
  applyRates(raw) {
    return {
      throttle: raw.throttle,
      yaw: expoCurve(raw.yaw, this.rates.yawExpo),
      pitch: expoCurve(raw.pitch, this.rates.expo),
      roll: expoCurve(raw.roll, this.rates.expo),
    };
  }

  /**
   * Keyboard fallback: W/S ramp throttle, A/D yaw, arrows pitch/roll.
   * @param {number} dt Frame delta time in seconds.
   * @returns {ControlInput}
   */
  pollKeyboard(dt) {
    const k = this.keys;
    if (k.has('KeyW')) this.keyboardThrottle += 0.8 * dt;
    if (k.has('KeyS')) this.keyboardThrottle -= 0.8 * dt;
    this.keyboardThrottle = Math.max(0, Math.min(1, this.keyboardThrottle));
    return {
      throttle: this.keyboardThrottle,
      yaw: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      pitch: (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0),
      roll: (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0),
    };
  }

  /**
   * Read input through the user's saved calibration: per-axis ranges,
   * detected channel assignment, and per-channel inversion.
   * @param {Gamepad} pad Active gamepad.
   * @returns {ControlInput}
   */
  pollCalibrated(pad) {
    const { axes, mapping } = this.calibration;
    /**
     * @param {'yaw'|'pitch'|'roll'} name Centered channel to read.
     * @returns {number}
     */
    const centered = (name) => {
      const m = mapping[name];
      const range = axes[m.axis];
      if (!range || pad.axes[m.axis] === undefined) return 0;
      return shapeAxis(normalizeCentered(range, pad.axes[m.axis]) * (m.invert ? -1 : 1));
    };

    const t = mapping.throttle;
    const tRange = axes[t.axis];
    let throttle = 0;
    if (tRange && pad.axes[t.axis] !== undefined) {
      const span = tRange.max - tRange.min;
      // Throttle sticks don't self-center: map the full travel to 0..1.
      throttle = span < 1e-6 ? 0 : (pad.axes[t.axis] - tRange.min) / span;
      if (t.invert) throttle = 1 - throttle;
      throttle = Math.max(0, Math.min(1, throttle));
    }
    return { throttle, yaw: centered('yaw'), pitch: centered('pitch'), roll: centered('roll') };
  }

  /**
   * Raw axis snapshot of the active gamepad (for the calibration UI).
   * @returns {number[]}
   */
  rawAxes() {
    const pad = this.activeGamepad();
    return pad ? Array.from(pad.axes) : [];
  }

  /**
   * Persist and activate a new calibration.
   * @param {Calibration} calibration Wizard result.
   */
  setCalibration(calibration) {
    this.calibration = calibration;
    this.channelMap = 'CUSTOM';
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
    } catch (err) {
      console.warn('Failed to persist calibration:', err);
    }
  }

  /** Remove the saved calibration and fall back to the AETR default. */
  clearCalibration() {
    this.calibration = null;
    this.channelMap = 'AETR';
    localStorage.removeItem(CALIBRATION_KEY);
  }

  /**
   * Load a previously saved calibration, if any.
   * @returns {Calibration | null}
   */
  static loadCalibration() {
    try {
      const raw = localStorage.getItem(CALIBRATION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.axes) || !parsed.mapping) return null;
      return parsed;
    } catch (err) {
      console.warn('Failed to load calibration:', err);
      return null;
    }
  }

  /** Reset stateful keyboard throttle (e.g. after a crash). */
  reset() {
    this.keyboardThrottle = 0;
  }
}
