/**
 * Ready-screen input configuration UI.
 *
 * Two layers over one binding model:
 *   - a preset dropdown (keyboard / Xbox / RadioMaster AETR / TAER) that fills
 *     the whole binding set in one click, for the common rigs;
 *   - a DCS-style binding grid (columns = devices, rows = controls) for manual
 *     per-cell assignment, reverse, and per-axis range calibration.
 *
 * Owns every input-settings DOM element and its wiring, so the main entry point
 * keeps only three seams — {@link ControlsUI#update}, {@link ControlsUI#isBusy},
 * {@link ControlsUI#previewControls} — plus settings-persistence delegation.
 */

import { AxisCapture } from './axisbind.js';
import { AxisCalibrator } from './calibration.js';
import { expoCurve, padById, setSelect } from './input.js';
import { PRESET_LIST, CHANNELS, defaultPresetFor } from './presets.js';

/** Self-contained styles for the binding grid; reuses the global --me-* palette. */
const style = document.createElement('style');
style.textContent = `
  #binding-overlay .ready-panel { width: min(80vw, calc(100vw - 2rem)); max-width: none; }
  #bind-grid { display: grid; width: 100%; gap: 6px; margin: 14px 0; overflow-x: auto; padding-bottom: 8px; }
  .bind-corner, .bind-devhead, .bind-rowlabel, .bind-cell {
    padding: 6px 8px; border: 1px solid var(--me-gray); border-radius: 3px;
    font-size: 0.8rem;
  }
  .bind-corner { border-color: transparent; }
  .bind-devhead {
    font-weight: 700; background: var(--me-light); text-align: center;
    display: flex; flex-direction: column; gap: 5px; justify-content: center;
  }
  .bind-devhead .devhead-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bind-rowlabel {
    font-weight: 700; background: var(--me-light); text-transform: uppercase;
    letter-spacing: 0.05em; display: flex; align-items: center;
  }
  .bind-cell {
    background: var(--me-panel); cursor: pointer; display: flex;
    flex-direction: column; gap: 4px; min-height: 60px; justify-content: center;
  }
  .bind-cell.empty { color: var(--me-mid); align-items: center; text-align: center; }
  .bind-cell.bound { cursor: default; }
  .bind-cell.active { outline: 2px solid var(--me-orange); outline-offset: -2px; }
  .bind-cell.capturing { align-items: center; text-align: center; cursor: pointer; }
  .bind-cell .capture-cancel-hint { font-size: 0.62rem; color: var(--me-mid); }
  .bind-cell.disabled { opacity: 0.4; pointer-events: none; }
  .bind-cell .cell-axis {
    font: inherit; font-weight: 700; background: none; border: none; padding: 0;
    color: var(--me-dark); cursor: pointer; text-align: center; white-space: nowrap;
  }
  .bind-cell .cell-axis:hover { color: var(--me-red); }
  .bind-cell .cell-axis:disabled { cursor: default; color: var(--me-dark); }
  .bind-cell .cell-head {
    display: flex; gap: 5px; align-items: center; justify-content: center;
    font-size: 0.72rem; flex-wrap: nowrap; white-space: nowrap;
  }
  .bind-cell .cell-sep { color: var(--me-gray); }
  .bind-cell label.cell-rev { display: flex; align-items: center; gap: 3px; cursor: pointer; height: 20px; }
  .bind-cell button.cell-btn {
    font: inherit; font-size: 0.72rem; border: 1px solid var(--me-gray);
    background: #fff; color: var(--me-dark); border-radius: 2px; cursor: pointer;
    padding: 0 6px; height: 20px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .bind-cell button.cell-btn:hover { background: var(--me-red); border-color: var(--me-red); color: #fff; }
  .bind-cell .cell-bar { height: 4px; background: var(--me-light); border-radius: 2px; overflow: hidden; }
  .bind-cell .cell-fill { height: 100%; width: 50%; background: var(--me-blue); }
  .bind-cell .cell-fill-cal { background: var(--me-orange); }
  .bind-cell .cell-meter { display: flex; align-items: center; gap: 5px; }
  .bind-cell .cell-meter .cell-bar { flex: 1; }
  .bind-cell .cell-calval {
    font-size: 0.66rem; color: var(--me-mid); min-width: 2.7em; text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .bind-devhead.offline { opacity: 0.55; font-style: italic; }
  .bind-cell.offline { background: var(--me-light); }
  .cell-move {
    font: inherit; font-size: 0.7rem; width: 100%; cursor: pointer;
    border: 1px solid var(--me-gray); border-radius: 2px; padding: 1px 2px;
    background: #fff; color: var(--me-dark);
  }
  .bind-empty-msg { grid-column: 1 / -1; padding: 1rem; text-align: center; color: var(--me-mid); }
  .ready-panel .secondary-button { width: min(320px, 100%); }
  #input-status.warn { color: var(--me-red); font-weight: 700; }
  .bind-rowlabel.warn { color: var(--me-red); }
  #bind-preview {
    position: absolute; top: 0.9rem; right: 0.9rem;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
  }
  #bind-preview .preview-viewport { perspective: 320px; width: 84px; height: 70px; }
  #bind-preview .preview-gimbal {
    width: 100%; height: 100%; display: grid; place-items: center;
    transform-style: preserve-3d; transform: rotateX(60deg);
  }
  #bind-preview .preview-drone { transform-style: preserve-3d; transition: transform 0.06s linear; }
  #bind-preview .preview-hint {
    font-size: 0.6rem; color: var(--me-mid); text-transform: uppercase; letter-spacing: 0.04em;
  }
`;
document.head.appendChild(style);

/**
 * Ready-screen tutorial text per input source. `disconnected` covers the case
 * where saved axis bindings are active but their controller isn't plugged in —
 * the bindings win over the keyboard, so nothing flies until it's connected.
 * @type {Record<'touch' | 'gamepad' | 'keyboard' | 'disconnected', string[]>}
 */
const TUTORIALS = {
  touch: [
    'Left stick — throttle (up / down) and yaw (turn). Throttle holds when you lift your thumb.',
    'Right stick — pitch (forward / back) and roll (bank). Springs back to center.',
    'Tap Start Flying, then race through the gates.',
  ],
  gamepad: [
    'Pick a Control Preset above — Xbox for a standard gamepad, AETR/TAER for a RadioMaster.',
    'Sticks map to throttle / yaw / pitch / roll. Move a stick to wake the device.',
    'Open Custom Binding for split HOTAS rigs, reversing an axis, or range calibration.',
  ],
  keyboard: [
    'W / S throttle · A / D yaw · Arrow keys pitch / roll.',
    'R reset · C camera · G god mode · O OSD.',
    'Connect a gamepad and pick a preset above for full stick control.',
  ],
  disconnected: [
    'Saved axis bindings are active, but their controller is not connected.',
    'Connect it and move a stick to wake it — the bindings take over automatically.',
    'Or pick Keyboard only above to fly without the controller.',
  ],
};

/** Display label per channel for the grid's row headers. */
const CHANNEL_LABELS = { throttle: 'Throttle', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };

/** A dim vertical separator between items in a cell header row. */
function sep() {
  const s = document.createElement('span');
  s.className = 'cell-sep';
  s.textContent = '|';
  return s;
}

/** Owns the ready-screen input configuration UI and its persistence. */
export class ControlsUI {
  /**
   * @param {import('./input.js').InputManager} input Shared input manager.
   * @param {boolean} isTouch Whether the on-screen touch pads are the source.
   * @param {() => void} onSettingsChange Called when a persisted control changes.
   */
  constructor(input, isTouch, onSettingsChange) {
    this.input = input;
    this.isTouch = isTouch;
    this.onSettingsChange = onSettingsChange;

    /**
     * Selected preset id, 'custom' once the grid is edited, or null for the
     * out-of-box auto path. Mirrors the dropdown and persists.
     * @type {string | null}
     */
    this.preset = null;

    this.presetSelect = document.getElementById('preset-select');
    this.readyTutorial = document.getElementById('ready-tutorial');
    this.advancedBind = document.getElementById('advanced-bind');
    this.inputStatus = document.getElementById('input-status');
    this.ratesButton = document.getElementById('rates-button');
    this.ratesOverlay = document.getElementById('rates-overlay');
    this.ratesDone = document.getElementById('rates-done');
    this.expoSlider = document.getElementById('expo-slider');
    this.expoValue = document.getElementById('expo-value');
    this.yawExpoSlider = document.getElementById('yaw-expo-slider');
    this.yawExpoValue = document.getElementById('yaw-expo-value');
    this.expoCanvas = document.getElementById('expo-curve');
    this.bindingOverlay = document.getElementById('binding-overlay');
    this.bindGrid = document.getElementById('bind-grid');
    this.previewDrone = this.bindingOverlay.querySelector('.preview-drone');
    this.bindStatus = document.getElementById('bind-status');
    this.bindDone = document.getElementById('bind-done');
    this.bindClear = document.getElementById('bind-clear');

    this.capture = new AxisCapture();
    this.calibrator = new AxisCalibrator();
    /** @type {{channel: string, deviceId: string} | null} Cell being (re)bound. */
    this.capturingCell = null;
    /** @type {{channel: string, deviceId: string} | null} Cell being calibrated. */
    this.calibratingCell = null;
    /**
     * Live bars per channel.
     * @type {Map<string, {fill: HTMLElement, rawVal: HTMLElement, calFill: HTMLElement|null, calVal: HTMLElement|null, channel: string, binding: import('./axisbind.js').AxisBinding}>}
     */
    this.cellBars = new Map();

    this.input.onDevicesChange = () => {
      this.syncPresetUi();
      if (!this.bindingOverlay.hidden) this.renderGrid();
    };
    this.presetSelect.addEventListener('change', () => this.onPresetChange());

    this.ratesButton.addEventListener('click', () => {
      this.drawExpoCurve();
      this.ratesOverlay.hidden = false;
    });
    this.ratesDone.addEventListener('click', () => { this.ratesOverlay.hidden = true; });
    this.expoSlider.addEventListener('input', () => this.syncRates());
    this.yawExpoSlider.addEventListener('input', () => this.syncRates());
    this.ratesOverlay.addEventListener('change', () => this.onSettingsChange());
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      if (!this.ratesOverlay.hidden) this.ratesOverlay.hidden = true;
      else if (this.capture.active) this.cancelCapture();
    });

    this.advancedBind.addEventListener('click', () => this.openGrid());
    this.bindDone.addEventListener('click', () => this.closeGrid());
    this.bindClear.addEventListener('click', () => {
      if (!window.confirm('Clear all axis bindings?')) return;
      this.capture.cancel();
      this.calibrator.cancel();
      this.capturingCell = null;
      this.calibratingCell = null;
      // Explicit empty set (not clearBindings/null) so the grid stays empty
      // instead of falling back to the auto preset.
      this.input.setBindings({});
      this.markCustom();
      this.renderGrid();
    });
  }

  /** Initial UI sync; call once after settings are loaded. */
  init() {
    this.fillPresetOptions();
    this.syncPresetUi();
    this.syncRates();
  }

  /**
   * Per-frame update: drive capture / calibration and the grid's live bars.
   * @param {number} dt Frame delta time in seconds.
   */
  update(dt) {
    if (this.bindingOverlay.hidden) return;
    this.capture.update(dt);
    this.calibrator.update(dt);
    this.updateBars();
    this.updatePreview();
  }

  /** True while the binding grid is open (arming must wait). */
  isBusy() {
    return !this.bindingOverlay.hidden;
  }

  /** True while an axis capture or calibration is in progress. */
  get busy() {
    return this.capture.active || this.calibrator.active;
  }

  /** No ready-screen preview needed; the grid shows its own live bars. */
  previewControls() {
    return null;
  }

  /**
   * Channels with no binding while custom bindings are active — those axes read
   * neutral and won't respond. Keyboard and the auto / out-of-box path are
   * complete sets, so they report nothing.
   * @returns {string[]}
   */
  missingChannels() {
    if (this.input.forceKeyboard) return [];
    const b = this.input.bindings;
    if (!b) return [];
    return CHANNELS.filter((c) => !b[c]);
  }

  /* ── Preset dropdown ─────────────────────────────────────────────── */

  /** Populate the preset dropdown: keyboard, the presets, and a Custom marker. */
  fillPresetOptions() {
    this.presetSelect.innerHTML = '';
    const add = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.presetSelect.appendChild(opt);
    };
    add('keyboard', 'Keyboard only');
    for (const p of PRESET_LIST) add(p.id, p.label);
    add('custom', 'Custom binding');
  }

  /** Apply the dropdown choice to the input manager. */
  onPresetChange() {
    const v = this.presetSelect.value;
    // 'custom' isn't a real choice — it only marks a grid-edited state.
    if (v === 'custom') { this.syncPresetUi(); return; }
    if (v === 'keyboard') {
      this.input.selectInput('keyboard');
      this.input.clearBindings();
      this.preset = 'keyboard';
    } else {
      this.input.selectInput('auto');
      // No connected pad to apply onto: don't record the choice — it would
      // mislead, since the device would fly the auto preset on connect, not this.
      if (!this.input.applyPreset(v)) {
        this.syncPresetUi();
        return;
      }
      this.preset = v;
    }
    this.onSettingsChange();
    this.syncPresetUi();
  }

  /** Reflect input state in the dropdown, status line, and tutorial. */
  syncPresetUi() {
    const pad = this.input.firstPad();
    const shown = this.input.forceKeyboard
      ? 'keyboard'
      : this.preset ?? (pad ? defaultPresetFor(pad) : 'keyboard');
    setSelect(this.presetSelect, shown);

    const label = (id) => PRESET_LIST.find((p) => p.id === id)?.label ?? id;
    const missing = this.missingChannels();
    if (this.awaitingDevice()) {
      // Saved bindings win over the keyboard, so with no controller nothing
      // flies — flag it rather than showing a reassuring preset line.
      this.inputStatus.textContent =
        '⚠ Controller not detected — connect it, or pick Keyboard only to fly.';
      this.inputStatus.classList.add('warn');
    } else if (missing.length) {
      this.inputStatus.textContent =
        `⚠ ${missing.map((c) => CHANNEL_LABELS[c]).join(', ')} unbound — won't respond. Pick a preset or bind them.`;
      this.inputStatus.classList.add('warn');
    } else {
      let status;
      if (this.input.forceKeyboard) status = 'Keyboard controls active.';
      else if (this.preset === 'custom') status = 'Custom axis bindings — open Custom Binding to edit.';
      else if (this.preset) status = `Preset: ${label(this.preset)}.`;
      else if (pad) status = `Auto preset: ${label(defaultPresetFor(pad))} — pick one or bind to customize.`;
      else status = 'No controller detected — keyboard fallback active.';
      this.inputStatus.textContent = status;
      this.inputStatus.classList.remove('warn');
    }

    this.updateTutorial();
  }

  /**
   * Effective input source given selection and connected hardware.
   * @returns {'touch' | 'gamepad' | 'keyboard'}
   */
  effectiveSource() {
    if (!this.input.forceKeyboard && this.input.firstPad()) return 'gamepad';
    return this.isTouch ? 'touch' : 'keyboard';
  }

  /**
   * True when saved bindings are active but no controller is connected: the
   * bindings win over the keyboard in the poll, so the drone won't respond
   * until a device is connected or Keyboard is selected. An empty saved set
   * (everything cleared) has nothing to await — that's reported as unbound
   * channels instead.
   * @returns {boolean}
   */
  awaitingDevice() {
    if (this.input.forceKeyboard) return false;
    const b = this.input.bindings;
    if (!b || !Object.values(b).some(Boolean)) return false;
    return !this.input.firstPad();
  }

  /** Rebuild the ready-screen tutorial list and the Advanced button visibility. */
  updateTutorial() {
    const key = this.awaitingDevice() ? 'disconnected' : this.effectiveSource();
    this.readyTutorial.innerHTML = '';
    for (const text of TUTORIALS[key]) {
      const li = document.createElement('li');
      li.textContent = text;
      this.readyTutorial.appendChild(li);
    }
    // The grid is for physical controller rigs, not the on-screen touch pads.
    this.advancedBind.hidden = this.isTouch;
  }

  /* ── Binding grid ────────────────────────────────────────────────── */

  /** Open the grid overlay and render it. */
  openGrid() {
    this.bindingOverlay.hidden = false;
    this.renderGrid();
  }

  /** Close the grid, cancelling any in-progress capture / calibration. */
  closeGrid() {
    this.capture.cancel();
    this.calibrator.cancel();
    this.capturingCell = null;
    this.calibratingCell = null;
    this.bindingOverlay.hidden = true;
    this.syncPresetUi();
  }

  /**
   * Bindings shown in the grid: the saved set, else the auto preset so a fresh
   * device's mapping is visible and tweakable, else empty.
   * @returns {Record<string, import('./axisbind.js').AxisBinding>}
   */
  currentBindings() {
    return this.input.bindings ?? this.input.autoBindings() ?? {};
  }

  /** Mark the config as custom (grid-edited) and refresh the dropdown state. */
  markCustom() {
    this.preset = 'custom';
    this.onSettingsChange();
  }

  /**
   * Write one channel's binding (inheriting the other channels), persist, and
   * mark custom. A1: one active binding per channel — this replaces any prior
   * binding for the channel, i.e. moves the assignment to the chosen column.
   * @param {string} channel Control channel.
   * @param {import('./axisbind.js').AxisBinding} binding New binding.
   */
  setBinding(channel, binding) {
    const base = { ...this.currentBindings() };
    base[channel] = binding;
    this.input.setBindings(base);
    this.markCustom();
  }

  /**
   * A device column header. Offline devices also get a "Move all" dropdown that
   * transfers every binding on that device to a connected one.
   * @param {{index?: number, id: string, connected: boolean}} device Column device.
   * @returns {HTMLElement}
   */
  renderDeviceHead(device) {
    const head = document.createElement('div');
    head.className = device.connected ? 'bind-devhead' : 'bind-devhead offline';
    head.title = device.id;
    const name = document.createElement('div');
    name.className = 'devhead-name';
    name.textContent = device.connected ? `${device.index}: ${device.id}` : `${device.id} (offline)`;
    head.appendChild(name);
    if (!device.connected) head.appendChild(this.buildMoveAll(device));
    return head;
  }

  /**
   * "Move all to…" dropdown for an offline device: transfers all of its
   * bindings onto the chosen connected device, after a confirm — the move
   * overwrites whatever bindings that device currently has.
   * @param {{id: string}} device Offline source device.
   * @returns {HTMLElement}
   */
  buildMoveAll(device) {
    const busy = this.busy;
    const connected = this.input.listGamepads();
    const move = document.createElement('select');
    move.className = 'cell-move';
    move.disabled = busy || connected.length === 0;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = connected.length ? 'Move all to…' : 'No device connected';
    move.appendChild(placeholder);
    for (const d of connected) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.index}: ${d.id}`;
      move.appendChild(opt);
    }
    move.addEventListener('change', () => {
      const targetId = move.value;
      move.value = '';
      if (!targetId) return;
      const target = connected.find((d) => d.id === targetId);
      const count = CHANNELS.filter((c) => this.currentBindings()[c]?.id === device.id).length;
      const ok = window.confirm(
        `Move all ${count} binding(s) from "${device.id}" onto "${target.id}"? ` +
          `This overwrites any bindings currently on "${target.id}".`
      );
      if (ok) this.moveDevice(device.id, targetId);
    });
    return move;
  }

  /**
   * Move every binding on one device onto another, keeping each axis /
   * direction / calibration. The target device's own bindings are dropped — it
   * takes over the source device's role.
   * @param {string} sourceId Source device id.
   * @param {string} targetId Target (connected) device id.
   */
  moveDevice(sourceId, targetId) {
    const target = this.input.listGamepads().find((d) => d.id === targetId);
    if (!target) return;
    const src = this.currentBindings();
    const next = {};
    for (const channel of CHANNELS) {
      const b = src[channel];
      if (!b) continue;
      if (b.id === sourceId) next[channel] = { ...b, id: target.id, index: target.index };
      else if (b.id !== targetId) next[channel] = b;
    }
    this.input.setBindings(next);
    this.markCustom();
    this.renderGrid();
  }

  /**
   * A cell in an offline device's column: shows the binding (when this channel
   * is bound to that device) with a per-cell clear. Moving is done per-device
   * from the column header ({@link buildMoveAll}).
   * @param {string} channel Control channel.
   * @param {import('./axisbind.js').AxisBinding | undefined} binding This channel's binding.
   * @param {boolean} bound Whether this channel is bound to the offline device.
   * @returns {HTMLElement}
   */
  renderOfflineCell(channel, binding, bound) {
    const cell = document.createElement('div');
    cell.className = 'bind-cell offline';
    if (!bound) {
      cell.classList.add('empty');
      cell.textContent = '—';
      return cell;
    }
    const busy = this.busy;
    cell.classList.add('bound');

    const axisLabel = document.createElement('span');
    axisLabel.className = 'cell-axis';
    axisLabel.textContent = `Axis ${binding.axis}`;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cell-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear this binding';
    clearBtn.disabled = busy;
    clearBtn.addEventListener('click', () => this.clearCell(channel));

    const head = document.createElement('div');
    head.className = 'cell-head';
    head.append(axisLabel, sep(), clearBtn);

    cell.appendChild(head);
    return cell;
  }

  /** Rebuild the grid DOM from the connected devices and current bindings. */
  renderGrid() {
    const grid = this.bindGrid;
    grid.innerHTML = '';
    this.cellBars = new Map();
    const bindings = this.currentBindings();
    const connected = this.input.listGamepads().map((d) => ({ ...d, connected: true }));
    const connectedIds = new Set(connected.map((d) => d.id));
    // Devices with a binding but not currently plugged in get an offline column,
    // so the binding stays visible and can be moved onto a live device.
    const offline = [...new Set(Object.values(bindings).filter(Boolean).map((b) => b.id))]
      .filter((id) => !connectedIds.has(id))
      .map((id) => ({ id, connected: false }));
    const devices = [...connected, ...offline];

    if (devices.length === 0) {
      grid.style.gridTemplateColumns = '1fr';
      const msg = document.createElement('div');
      msg.className = 'bind-empty-msg';
      msg.textContent = 'No controllers detected. Connect one and move an axis to wake it.';
      grid.appendChild(msg);
      this.bindStatus.textContent = '';
      return;
    }

    grid.style.gridTemplateColumns = `minmax(64px, max-content) repeat(${devices.length}, minmax(184px, 1fr))`;
    const corner = document.createElement('div');
    corner.className = 'bind-corner';
    grid.appendChild(corner);
    for (const d of devices) grid.appendChild(this.renderDeviceHead(d));

    const missing = this.missingChannels();
    for (const channel of CHANNELS) {
      const rowLabel = document.createElement('div');
      rowLabel.className = missing.includes(channel) ? 'bind-rowlabel warn' : 'bind-rowlabel';
      rowLabel.textContent = CHANNEL_LABELS[channel];
      grid.appendChild(rowLabel);
      for (const d of devices) grid.appendChild(this.renderCell(channel, d, bindings[channel]));
    }
    // Don't clobber an in-progress capture / calibration message.
    if (!this.busy) {
      this.bindStatus.textContent = missing.length
        ? `⚠ ${missing.map((c) => CHANNEL_LABELS[c]).join(', ')} unbound — those axes won't respond.`
        : '';
    }
  }

  /**
   * One grid cell for (channel, device). Offline device columns delegate to
   * {@link renderOfflineCell}.
   * @param {string} channel Control channel.
   * @param {{index?: number, id: string, connected: boolean}} device Column device.
   * @param {import('./axisbind.js').AxisBinding | undefined} binding This channel's binding.
   * @returns {HTMLElement}
   */
  renderCell(channel, device, binding) {
    const bound = binding && binding.id === device.id;
    if (!device.connected) return this.renderOfflineCell(channel, binding, bound);
    const cell = document.createElement('div');
    cell.className = 'bind-cell';
    const capturing = this.capturingCell?.channel === channel && this.capturingCell?.deviceId === device.id;
    const calibrating = this.calibratingCell?.channel === channel && this.calibratingCell?.deviceId === device.id;
    const busy = this.busy;

    if (capturing) {
      cell.className = 'bind-cell active capturing';
      const main = document.createElement('div');
      main.textContent = 'Move the axis and hold…';
      const hint = document.createElement('div');
      hint.className = 'capture-cancel-hint';
      hint.textContent = 'click or Esc to cancel';
      cell.append(main, hint);
      cell.addEventListener('click', () => this.cancelCapture());
      return cell;
    }
    if (!bound) {
      cell.className = 'bind-cell empty';
      cell.textContent = busy ? '—' : 'Click to bind';
      if (busy) cell.classList.add('disabled');
      else cell.addEventListener('click', () => this.beginCapture(channel, device.id));
      return cell;
    }

    cell.classList.add('bound');
    if (busy && !calibrating) cell.classList.add('disabled');
    if (calibrating) cell.classList.add('active');

    const axisLabel = document.createElement('button');
    axisLabel.type = 'button';
    axisLabel.className = 'cell-axis';
    axisLabel.textContent = `Axis ${binding.axis}`;
    axisLabel.title = 'Click to rebind this control';
    axisLabel.disabled = busy;
    axisLabel.addEventListener('click', () => this.beginCapture(channel, device.id));

    const head = document.createElement('div');
    head.className = 'cell-head';

    const rev = document.createElement('label');
    rev.className = 'cell-rev';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = binding.sign < 0;
    cb.disabled = busy;
    cb.addEventListener('change', () => this.toggleReverse(channel));
    rev.append(cb, document.createTextNode('Rev'));

    const calBtn = document.createElement('button');
    calBtn.type = 'button';
    calBtn.className = 'cell-btn';
    calBtn.textContent = calibrating ? 'Finish' : binding.range ? 'Cal ✓' : 'Cal';
    calBtn.title = binding.range ? 'Click to remove calibration' : 'Calibrate axis range';
    calBtn.addEventListener('click', () => {
      if (calibrating) this.finishCalibration();
      else if (binding.range) this.removeRange(channel);
      else this.beginCalibration(channel, device.id, binding);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cell-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear this binding';
    clearBtn.disabled = busy;
    clearBtn.addEventListener('click', () => this.clearCell(channel));

    head.append(axisLabel, sep(), rev, sep(), calBtn, sep(), clearBtn);

    const rawRow = document.createElement('div');
    rawRow.className = 'cell-meter';
    const bar = document.createElement('div');
    bar.className = 'cell-bar';
    const fill = document.createElement('div');
    fill.className = 'cell-fill';
    bar.appendChild(fill);
    const rawVal = document.createElement('span');
    rawVal.className = 'cell-calval';
    rawVal.textContent = '0.00';
    rawRow.append(bar, rawVal);
    cell.append(head, rawRow);

    // Calibrated channels get a second bar + numeric readout for the post-cal
    // value (raw normalized through the range), so the effect is visible.
    let calFill = null;
    let calVal = null;
    if (binding.range) {
      const calRow = document.createElement('div');
      calRow.className = 'cell-meter';
      const calBar = document.createElement('div');
      calBar.className = 'cell-bar';
      calFill = document.createElement('div');
      calFill.className = 'cell-fill cell-fill-cal';
      calBar.appendChild(calFill);
      calVal = document.createElement('span');
      calVal.className = 'cell-calval';
      calVal.textContent = '0.00';
      calRow.append(calBar, calVal);
      cell.appendChild(calRow);
    }
    this.cellBars.set(channel, { fill, rawVal, calFill, calVal, channel, binding });

    return cell;
  }

  /**
   * Start capturing an axis on a device for a channel.
   * @param {string} channel Control channel.
   * @param {string} deviceId Target device id.
   */
  beginCapture(channel, deviceId) {
    if (this.busy) return;
    this.capturingCell = { channel, deviceId };
    this.bindStatus.textContent = `Binding ${CHANNEL_LABELS[channel]} — move the axis and hold.`;
    this.capture.start(
      deviceId,
      (binding) => {
        this.capturingCell = null;
        this.setBinding(channel, binding);
        this.bindStatus.textContent = `${CHANNEL_LABELS[channel]} bound to axis ${binding.axis}.`;
        this.renderGrid();
      },
      (pct, axis) => {
        this.bindStatus.textContent =
          axis === null ? 'Move only the axis you want to bind.' : `Detected axis ${axis} — hold… ${pct}%`;
      }
    );
    this.renderGrid();
  }

  /** Abort an in-progress capture, reverting the cell to its prior state. */
  cancelCapture() {
    if (!this.capture.active) return;
    this.capture.cancel();
    this.capturingCell = null;
    // renderGrid resets bind-status now that nothing is capturing.
    this.renderGrid();
  }

  /**
   * Flip a channel's direction.
   * @param {string} channel Control channel.
   */
  toggleReverse(channel) {
    const b = this.currentBindings()[channel];
    if (!b) return;
    this.setBinding(channel, { ...b, sign: -b.sign });
    this.renderGrid();
  }

  /**
   * Clear one channel's binding, reverting the cell to unbound. Clearing the
   * last remaining binding drops back to the auto-preset path.
   * @param {string} channel Control channel.
   */
  clearCell(channel) {
    if (this.busy) return;
    const base = { ...this.currentBindings() };
    delete base[channel];
    // Keep the explicit set (empty {} included) so cleared cells stay cleared
    // rather than reverting to the auto preset.
    this.input.setBindings(base);
    this.markCustom();
    this.renderGrid();
  }

  /**
   * Start range calibration for a bound cell.
   * @param {string} channel Control channel.
   * @param {string} deviceId Device id.
   * @param {import('./axisbind.js').AxisBinding} binding Cell binding.
   */
  beginCalibration(channel, deviceId, binding) {
    if (this.busy) return;
    this.calibratingCell = { channel, deviceId };
    this.bindStatus.textContent =
      `Calibrating ${CHANNEL_LABELS[channel]} — sweep the axis through its full range, leave it at rest, then Finish.`;
    this.calibrator.start(binding, (range) => {
      this.calibratingCell = null;
      const b = this.currentBindings()[channel];
      if (b) this.setBinding(channel, { ...b, range });
      this.bindStatus.textContent = `${CHANNEL_LABELS[channel]} range calibrated.`;
      this.renderGrid();
    });
    this.renderGrid();
  }

  /** Finish the in-progress calibration. */
  finishCalibration() {
    this.calibrator.finish();
  }

  /**
   * Remove a channel's range calibration, keeping the axis binding itself.
   * @param {string} channel Control channel.
   */
  removeRange(channel) {
    const b = { ...this.currentBindings()[channel] };
    if (!b.range) return;
    delete b.range;
    this.setBinding(channel, b);
    this.renderGrid();
  }

  /** Update the live fill bars for every bound cell from current axis values. */
  updateBars() {
    if (this.cellBars.size === 0) return;
    const pads = navigator.getGamepads();
    for (const { fill, rawVal, calFill, calVal, channel, binding } of this.cellBars.values()) {
      const pad = padById(binding.id, pads);
      const rawV = pad && pad.axes[binding.axis] !== undefined ? pad.axes[binding.axis] : 0;
      fill.style.width = `${((Math.max(-1, Math.min(1, rawV)) + 1) / 2) * 100}%`;
      if (rawVal) rawVal.textContent = rawV.toFixed(2);
      if (calFill && binding.range) {
        const after = this.input.channelValue(channel, binding, rawV);
        // Throttle reads 0..1 (left = idle); centered channels -1..1 (mid = center).
        const pct = channel === 'throttle' ? after * 100 : ((after + 1) / 2) * 100;
        calFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        if (calVal) calVal.textContent = after.toFixed(2);
      }
    }
  }

  /**
   * Rotate the little preview drone to the live pitch / yaw / roll, so the user
   * can see which way a bound axis banks / pitches / turns the aircraft (and
   * whether it needs Rev) instead of reading numbers. Throttle isn't attitude.
   */
  updatePreview() {
    if (!this.previewDrone) return;
    const b = this.currentBindings();
    const pads = navigator.getGamepads();
    const val = (ch) => {
      const bind = b[ch];
      if (!bind) return 0;
      const pad = padById(bind.id, pads);
      if (!pad || pad.axes[bind.axis] === undefined) return 0;
      return this.input.channelValue(ch, bind, pad.axes[bind.axis]);
    };
    const pitch = val('pitch');
    const roll = val('roll');
    const yaw = val('yaw');
    this.previewDrone.style.transform =
      `rotateZ(${yaw * 55}deg) rotateX(${pitch * 45}deg) rotateY(${roll * 45}deg)`;
  }

  /* ── Rates & Expo ────────────────────────────────────────────────── */

  /** Redraw the expo-curve preview: linear reference plus both active curves. */
  drawExpoCurve() {
    const ctx = this.expoCanvas.getContext('2d');
    const w = this.expoCanvas.width;
    const h = this.expoCanvas.height;
    const pad = 12;
    const toX = (v) => pad + ((v + 1) / 2) * (w - pad * 2);
    const toY = (v) => h - pad - ((v + 1) / 2) * (h - pad * 2);

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#C9D1D6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(toX(-1), toY(0));
    ctx.lineTo(toX(1), toY(0));
    ctx.moveTo(toX(0), toY(-1));
    ctx.lineTo(toX(0), toY(1));
    ctx.stroke();

    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(toX(-1), toY(-1));
    ctx.lineTo(toX(1), toY(1));
    ctx.stroke();
    ctx.setLineDash([]);

    const plot = (expo, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 64; i++) {
        const x = -1 + (i / 64) * 2;
        const y = expoCurve(x, expo);
        if (i === 0) ctx.moveTo(toX(x), toY(y));
        else ctx.lineTo(toX(x), toY(y));
      }
      ctx.stroke();
    };
    plot(this.input.rates.yawExpo, '#4FA3D9');
    plot(this.input.rates.expo, '#E0301E');

    ctx.font = '11px monospace';
    ctx.fillStyle = '#E0301E';
    ctx.fillText('PITCH/ROLL', pad + 2, pad + 10);
    ctx.fillStyle = '#4FA3D9';
    ctx.fillText('YAW', pad + 2, pad + 24);
  }

  /** Push the slider values into the input rates, labels, and curve preview. */
  syncRates() {
    this.input.rates.expo = Number(this.expoSlider.value) / 100;
    this.input.rates.yawExpo = Number(this.yawExpoSlider.value) / 100;
    this.expoValue.textContent = `${this.expoSlider.value}%`;
    this.yawExpoValue.textContent = `${this.yawExpoSlider.value}%`;
    this.drawExpoCurve();
  }

  /* ── Settings persistence ────────────────────────────────────────── */

  /**
   * Input-related fields for settings persistence.
   * @returns {{preset: string | null, expo: string, yawExpo: string}}
   */
  collectSettings() {
    return {
      preset: this.preset,
      expo: this.expoSlider.value,
      yawExpo: this.yawExpoSlider.value,
    };
  }

  /**
   * Restore input-related settings. Saved bindings are loaded by the input
   * manager itself; here we only restore the preset choice and rates.
   * @param {Record<string, unknown>} s Parsed settings blob.
   */
  applySettings(s) {
    if (typeof s.preset === 'string') {
      this.preset = s.preset;
      if (s.preset === 'keyboard') this.input.selectInput('keyboard');
    }
    if (s.expo !== undefined && Number.isFinite(Number(s.expo))) {
      this.expoSlider.value = String(s.expo);
    }
    if (s.yawExpo !== undefined && Number.isFinite(Number(s.yawExpo))) {
      this.yawExpoSlider.value = String(s.yawExpo);
    }
  }
}
