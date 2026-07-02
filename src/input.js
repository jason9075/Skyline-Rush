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
/** localStorage key for persisted multi-device axis bindings. */
const BINDINGS_KEY = 'drone-control.bindings';

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
    /**
     * DCS-style per-axis, cross-device bindings; take priority over the single
     * gamepad path when complete. See {@link import('./axisbind.js').AxisBinder}.
     * @type {Record<string, import('./axisbind.js').AxisBinding> | null}
     */
    this.bindings = InputManager.loadBindings();
    /**
     * User-chosen gamepad index; null selects the first connected pad (auto).
     * @type {number | null}
     */
    this.selectedIndex = null;
    /** When true, ignore any gamepad and use the keyboard. */
    this.forceKeyboard = false;
    /** Last status string emitted, to debounce {@link onStatusChange}. */
    this.lastStatus = null;
    /** @type {(() => void) | null} Fired when the connected-gamepad set changes. */
    this.onDevicesChange = null;
    /** @type {import('./touch.js').TouchControls | null} */
    this.touch = null;
    /** @type {(status: string) => void} */
    this.onStatusChange = onStatusChange;
    /** @type {Set<string>} */
    this.keys = new Set();
    /** Keyboard throttle is stateful so W/S nudge it up and down. */
    this.keyboardThrottle = 0;
    /** Expo amounts in [0, 1] applied to the centered channels. */
    this.rates = { expo: 0, yawExpo: 0 };

    window.addEventListener('gamepadconnected', () => {
      if (this.onDevicesChange) this.onDevicesChange();
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      // Drop an explicit selection that just vanished so we fall back to auto.
      if (e.gamepad.index === this.selectedIndex) this.selectedIndex = null;
      if (this.onDevicesChange) this.onDevicesChange();
    });
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  /**
   * Resolve the active gamepad for this frame. The user's explicit selection
   * ({@link selectedIndex}) wins while it stays connected; otherwise the first
   * connected pad is used. `getGamepads()` must be re-polled every frame — its
   * state objects are snapshots — and it also surfaces pads plugged in before
   * the page, which some browsers never announce via 'gamepadconnected'.
   * @returns {Gamepad | null}
   */
  activeGamepad() {
    if (this.forceKeyboard) {
      this.setStatus('Input: keyboard (selected)');
      return null;
    }
    const pads = navigator.getGamepads();
    const pad =
      (this.selectedIndex !== null && pads[this.selectedIndex]) ||
      Array.from(pads).find((p) => p) ||
      null;
    this.setStatus(pad ? `Gamepad: ${pad.id}` : 'Gamepad: none (keyboard fallback active)');
    return pad;
  }

  /**
   * Emit a status string, debounced so the per-frame poll doesn't spam it.
   * @param {string} msg Status message.
   */
  setStatus(msg) {
    if (msg === this.lastStatus) return;
    this.lastStatus = msg;
    this.onStatusChange(msg);
  }

  /**
   * List currently connected gamepads (for the device selector).
   * @returns {{index: number, id: string}[]}
   */
  listGamepads() {
    return Array.from(navigator.getGamepads())
      .filter((p) => p)
      .map((p) => ({ index: p.index, id: p.id }));
  }

  /**
   * Choose the active input source.
   * @param {'auto' | 'keyboard' | number} sel `'auto'` = first connected pad,
   *   `'keyboard'` = force keyboard, or a specific gamepad index.
   */
  selectInput(sel) {
    this.forceKeyboard = sel === 'keyboard';
    this.selectedIndex = typeof sel === 'number' ? sel : null;
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
    // DCS-style multi-device bindings win when complete (and not overridden by
    // an explicit keyboard selection): they read each channel from its own
    // device, so split HOTAS / dual-stick rigs bypass the single-pad path.
    if (!this.forceKeyboard && this.hasBindings()) return this.pollBindings();
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
    if (this.touch) {
      // Once mounted (touch devices only), touch is the source even between
      // taps, so the held throttle survives lifting a thumb.
      return {
        throttle: this.touch.throttle,
        yaw: shapeAxis(this.touch.yaw),
        pitch: shapeAxis(this.touch.pitch),
        roll: shapeAxis(this.touch.roll),
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

  /** True when a complete set of multi-device axis bindings is active. */
  hasBindings() {
    const b = this.bindings;
    return Boolean(b && b.throttle && b.yaw && b.pitch && b.roll);
  }

  /**
   * Re-resolve a bound device: prefer the recorded index when its id still
   * matches, else the first connected pad sharing the id (survives index
   * shuffling on reconnect).
   * @param {(Gamepad | null)[]} pads Snapshot from navigator.getGamepads().
   * @param {import('./axisbind.js').AxisBinding} bind Axis binding.
   * @returns {Gamepad | null}
   */
  resolvePad(pads, bind) {
    const byIndex = pads[bind.index];
    if (byIndex && byIndex.id === bind.id) return byIndex;
    return Array.from(pads).find((p) => p && p.id === bind.id) || byIndex || null;
  }

  /**
   * Read each channel from its own bound (device, axis), applying the captured
   * direction. Centered channels are deadband-shaped; throttle maps [-1,1]→[0,1].
   * @returns {ControlInput}
   */
  pollBindings() {
    this.setStatus('Input: custom axis bindings');
    const pads = navigator.getGamepads();
    /**
     * @param {import('./axisbind.js').AxisBinding} bind Axis binding.
     * @returns {number}
     */
    const read = (bind) => {
      const pad = this.resolvePad(pads, bind);
      if (!pad || pad.axes[bind.axis] === undefined) return 0;
      return pad.axes[bind.axis] * bind.sign;
    };
    const b = this.bindings;
    return {
      throttle: Math.max(0, Math.min(1, (read(b.throttle) + 1) / 2)),
      yaw: shapeAxis(read(b.yaw)),
      pitch: shapeAxis(read(b.pitch)),
      roll: shapeAxis(read(b.roll)),
    };
  }

  /**
   * Persist and activate multi-device axis bindings.
   * @param {Record<string, import('./axisbind.js').AxisBinding>} bindings Binder result.
   */
  setBindings(bindings) {
    this.bindings = bindings;
    try {
      localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
    } catch (err) {
      console.warn('Failed to persist bindings:', err);
    }
  }

  /** Remove saved axis bindings, reverting to the single-device path. */
  clearBindings() {
    this.bindings = null;
    localStorage.removeItem(BINDINGS_KEY);
  }

  /**
   * Load previously saved axis bindings, if a complete set exists.
   * @returns {Record<string, import('./axisbind.js').AxisBinding> | null}
   */
  static loadBindings() {
    try {
      const raw = localStorage.getItem(BINDINGS_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      if (!b || !b.throttle || !b.yaw || !b.pitch || !b.roll) return null;
      return b;
    } catch (err) {
      console.warn('Failed to load bindings:', err);
      return null;
    }
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

  /**
   * Attach on-screen touch joysticks as an input source (touch devices only).
   * @param {import('./touch.js').TouchControls} touch Mounted touch controls.
   */
  setTouchControls(touch) {
    this.touch = touch;
  }

  /** True while a touch joystick is currently under a finger. */
  touchActive() {
    return Boolean(this.touch && this.touch.active);
  }

  /** Reset stateful keyboard/touch throttle (e.g. after a crash). */
  reset() {
    this.keyboardThrottle = 0;
    if (this.touch) this.touch.reset();
  }
}
