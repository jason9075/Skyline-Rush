/**
 * Input handling: game controllers via the Gamepad API, mapped through per-axis
 * bindings (filled by a preset or the binding grid), with a keyboard fallback.
 *
 * Normalized output convention:
 *   throttle: 0..1   (0 = idle, 1 = full thrust)
 *   yaw:     -1..1   (positive = yaw right)
 *   pitch:   -1..1   (positive = nose forward)
 *   roll:    -1..1   (positive = bank right)
 */

import { presetBindings, defaultPresetFor } from './presets.js';

/** Stick deadband applied to yaw/pitch/roll axes. */
const DEADBAND = 0.04;

/** localStorage key for persisted multi-device axis bindings. */
const BINDINGS_KEY = 'drone-control.bindings';

/**
 * @typedef {Object} AxisRange
 * @property {number} min Raw minimum seen during calibration.
 * @property {number} center Raw neutral position.
 * @property {number} max Raw maximum seen during calibration.
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
    /**
     * DCS-style per-axis, cross-device bindings; every controller channel reads
     * through these (see {@link pollBindings}). Null until a preset or the
     * binding grid fills them.
     * @type {Record<string, import('./axisbind.js').AxisBinding> | null}
     */
    this.bindings = InputManager.loadBindings();
    /**
     * Cached auto-preset for the out-of-box path, keyed by device id so the
     * binding object stays stable across frames. Not persisted.
     * @type {{id: string, bindings: Record<string, import('./axisbind.js').AxisBinding>} | null}
     */
    this.autoCache = null;
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
    const pad = this.firstPad();
    this.setStatus(pad ? `Gamepad: ${pad.id}` : 'Gamepad: none (keyboard fallback active)');
    return pad;
  }

  /**
   * The device the auto/selected path resolves to, without side effects: the
   * explicit selection while it stays connected, else the first connected pad.
   * @returns {Gamepad | null}
   */
  firstPad() {
    const pads = navigator.getGamepads();
    return (this.selectedIndex !== null && pads[this.selectedIndex]) || Array.from(pads).find((p) => p) || null;
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
    // Every controller channel flows through the binding set: the user's saved
    // bindings when present, else an auto preset for the connected pad so a
    // fresh device flies without opening the grid. Split HOTAS / dual-stick
    // rigs read each channel from its own device here.
    if (!this.forceKeyboard) {
      // A saved set (even a partial one, if some cells were cleared) wins;
      // otherwise a connected pad flies via its auto preset.
      const bindings = this.bindings ?? this.autoBindings();
      if (bindings) return this.pollBindings(bindings);
    }
    if (this.touch) {
      // Once mounted (touch devices only), touch is the source even between
      // taps, so the held throttle survives lifting a thumb.
      this.setStatus('Input: touch');
      return {
        throttle: this.touch.throttle,
        yaw: shapeAxis(this.touch.yaw),
        pitch: shapeAxis(this.touch.pitch),
        roll: shapeAxis(this.touch.roll),
      };
    }
    this.setStatus(
      this.forceKeyboard ? 'Input: keyboard (selected)' : 'Gamepad: none (keyboard fallback active)'
    );
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

  /** True when a complete set of multi-device axis bindings is active. */
  hasBindings() {
    const b = this.bindings;
    return Boolean(b && b.throttle && b.yaw && b.pitch && b.roll);
  }

  /**
   * Transient binding set for the out-of-box path: when the user hasn't saved
   * bindings yet, a connected pad still flies via its best-guess preset. Not
   * persisted; cached per device id so the object is stable across frames.
   * @returns {Record<string, import('./axisbind.js').AxisBinding> | null}
   */
  autoBindings() {
    const pad = this.firstPad();
    if (!pad) return null;
    if (this.autoCache && this.autoCache.id === pad.id) return this.autoCache.bindings;
    const bindings = presetBindings(defaultPresetFor(pad), pad);
    this.autoCache = { id: pad.id, bindings };
    return bindings;
  }

  /**
   * Apply a named preset to the currently selected/first pad and persist it.
   * @param {string} name Preset id (see {@link import('./presets.js').PRESET_LIST}).
   * @returns {Record<string, import('./axisbind.js').AxisBinding> | null} Saved set, or null.
   */
  applyPreset(name) {
    const bindings = presetBindings(name, this.firstPad());
    if (bindings) this.setBindings(bindings);
    return bindings;
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
   * direction. A binding may carry a calibrated range; without one the raw axis
   * is assumed self-normalized to [-1, 1]. Centered channels are deadband-shaped;
   * throttle maps full travel to [0, 1].
   * @param {Record<string, import('./axisbind.js').AxisBinding>} bindings Active set.
   * @returns {ControlInput}
   */
  pollBindings(bindings) {
    this.setStatus('Input: custom axis bindings');
    const pads = navigator.getGamepads();
    /**
     * Raw value of a binding's axis, or null when its device/axis is gone.
     * @param {import('./axisbind.js').AxisBinding} bind Axis binding.
     * @returns {number | null}
     */
    const rawOf = (bind) => {
      if (!bind) return null;
      const pad = this.resolvePad(pads, bind);
      return pad && pad.axes[bind.axis] !== undefined ? pad.axes[bind.axis] : null;
    };
    return {
      throttle: this.channelValue('throttle', bindings.throttle, rawOf(bindings.throttle)),
      yaw: this.channelValue('yaw', bindings.yaw, rawOf(bindings.yaw)),
      pitch: this.channelValue('pitch', bindings.pitch, rawOf(bindings.pitch)),
      roll: this.channelValue('roll', bindings.roll, rawOf(bindings.roll)),
    };
  }

  /**
   * Final control value for one channel's binding at a raw axis reading, shared
   * by the live poll and the grid's after-calibration readout. Throttle maps
   * full travel to [0, 1] (no center); centered channels normalize to [-1, 1]
   * and are deadband-shaped. A missing binding or lost device reads neutral (0).
   * @param {string} channel Control channel.
   * @param {import('./axisbind.js').AxisBinding | undefined} bind Axis binding.
   * @param {number | null} rawValue Current raw axis value.
   * @returns {number}
   */
  channelValue(channel, bind, rawValue) {
    if (!bind || rawValue === null) return 0;
    if (channel === 'throttle') {
      let t;
      if (bind.range) {
        const span = bind.range.max - bind.range.min;
        // Throttle sticks don't self-center: map full travel to 0..1.
        t = span < 1e-6 ? 0 : (rawValue - bind.range.min) / span;
        if (bind.sign < 0) t = 1 - t;
      } else {
        t = (rawValue * bind.sign + 1) / 2;
      }
      return Math.max(0, Math.min(1, t));
    }
    const v = bind.range ? normalizeCentered(bind.range, rawValue) : rawValue;
    return shapeAxis(v * bind.sign);
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
      if (!b || typeof b !== 'object') return null;
      // Accept partial or empty sets: the grid can clear channels, and an
      // explicit empty {} means "cleared" — distinct from no saved key (= auto).
      return b;
    } catch (err) {
      console.warn('Failed to load bindings:', err);
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
