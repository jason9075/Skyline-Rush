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

/** Polls gamepads and keyboard, exposing one normalized ControlInput per frame. */
export class InputManager {
  /**
   * @param {(status: string) => void} onStatusChange Called when the active input source changes.
   */
  constructor(onStatusChange) {
    /** @type {string} */
    this.channelMap = 'AETR';
    /** @type {number | null} */
    this.gamepadIndex = null;
    /** @type {(status: string) => void} */
    this.onStatusChange = onStatusChange;
    /** @type {Set<string>} */
    this.keys = new Set();
    /** Keyboard throttle is stateful so W/S nudge it up and down. */
    this.keyboardThrottle = 0;

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
   * Read the active gamepad, if any.
   * @returns {Gamepad | null}
   */
  activeGamepad() {
    if (this.gamepadIndex === null) return null;
    // getGamepads() must be re-polled every frame; state objects are snapshots.
    return navigator.getGamepads()[this.gamepadIndex] ?? null;
  }

  /**
   * Poll the current control input.
   * @param {number} dt Frame delta time in seconds (used by the keyboard throttle ramp).
   * @returns {ControlInput}
   */
  poll(dt) {
    const pad = this.activeGamepad();
    if (pad && pad.axes.length >= 4) {
      const map = CHANNEL_MAPS[this.channelMap];
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

  /** Reset stateful keyboard throttle (e.g. after a crash). */
  reset() {
    this.keyboardThrottle = 0;
  }
}
