/**
 * Axis-binding presets: one-click factory maps that fill a whole
 * {@link import('./axisbind.js').AxisBinding} set from a single device's
 * standard axis layout, so the common rigs (a standard gamepad, a RadioMaster
 * transmitter) work without opening the DCS-style binding grid.
 *
 * Sign convention matches the poll: throttle up = +1, yaw right = +1,
 * pitch forward = +1, roll right = +1. Sticks read negative when pushed
 * forward/up (HID), so those channels invert.
 */

/**
 * Per-channel (axis index, sign) for each preset, on the target device.
 * @type {Record<string, Record<'throttle'|'yaw'|'pitch'|'roll', {axis: number, sign: number}>>}
 */
const PRESETS = {
  // Standard gamepad (Xbox), Mode 2: left stick = throttle/yaw, right = pitch/roll.
  xbox: {
    throttle: { axis: 1, sign: -1 },
    yaw: { axis: 0, sign: 1 },
    pitch: { axis: 3, sign: -1 },
    roll: { axis: 2, sign: 1 },
  },
  // RadioMaster (EdgeTX) USB joystick, AETR mixer order.
  aetr: {
    throttle: { axis: 2, sign: 1 },
    yaw: { axis: 3, sign: 1 },
    pitch: { axis: 1, sign: -1 },
    roll: { axis: 0, sign: 1 },
  },
  // RadioMaster, TAER mixer order.
  taer: {
    throttle: { axis: 0, sign: 1 },
    yaw: { axis: 3, sign: 1 },
    pitch: { axis: 2, sign: -1 },
    roll: { axis: 1, sign: 1 },
  },
};

/** Selectable presets in dropdown order. */
export const PRESET_LIST = [
  { id: 'xbox', label: 'Xbox / Standard Gamepad' },
  { id: 'aetr', label: 'RadioMaster (AETR)' },
  { id: 'taer', label: 'RadioMaster (TAER)' },
];

/** Channels a complete binding set covers. */
export const CHANNELS = ['throttle', 'yaw', 'pitch', 'roll'];

/**
 * Build a complete binding set for a preset applied to one device. Returns null
 * when the preset is unknown or no device is given (e.g. the keyboard choice).
 * @param {string} name Preset id.
 * @param {Gamepad | null} pad Target device.
 * @returns {Record<string, import('./axisbind.js').AxisBinding> | null}
 */
export function presetBindings(name, pad) {
  const preset = PRESETS[name];
  if (!preset || !pad) return null;
  const bindings = {};
  for (const channel of CHANNELS) {
    bindings[channel] = {
      index: pad.index,
      id: pad.id,
      axis: preset[channel].axis,
      sign: preset[channel].sign,
    };
  }
  return bindings;
}

/**
 * Best-guess preset for a freshly connected device, used for the out-of-box
 * "plug in and fly" path before the user picks one: the Gamepad API reports a
 * standard-mapped pad (Xbox layout) as 'standard'; anything else is treated as
 * a RadioMaster in the EdgeTX default (AETR).
 * @param {Gamepad | null} pad Connected device.
 * @returns {string}
 */
export function defaultPresetFor(pad) {
  return pad && pad.mapping === 'standard' ? 'xbox' : 'aetr';
}
