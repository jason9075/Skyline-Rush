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
import { expoCurve } from './input.js';
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
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bind-rowlabel {
    font-weight: 700; background: var(--me-light); text-transform: uppercase;
    letter-spacing: 0.05em; display: flex; align-items: center;
  }
  .bind-cell {
    background: var(--me-panel); cursor: pointer; display: flex;
    flex-direction: column; gap: 4px; min-height: 3.4em; justify-content: center;
  }
  .bind-cell.empty { color: var(--me-mid); align-items: center; text-align: center; }
  .bind-cell.bound { cursor: default; }
  .bind-cell.active { outline: 2px solid var(--me-orange); outline-offset: -2px; }
  .bind-cell.disabled { opacity: 0.4; pointer-events: none; }
  .bind-cell .cell-axis {
    font: inherit; font-weight: 700; background: none; border: none; padding: 0;
    color: var(--me-dark); cursor: pointer; text-align: center; white-space: nowrap;
  }
  .bind-cell .cell-axis:hover { color: var(--me-red); }
  .bind-cell .cell-axis:disabled { cursor: default; color: var(--me-dark); }
  .bind-cell .cell-actions {
    display: flex; gap: 5px; align-items: center; justify-content: center;
    font-size: 0.72rem; flex-wrap: nowrap; white-space: nowrap;
  }
  .bind-cell label.cell-rev { display: flex; align-items: center; gap: 3px; cursor: pointer; }
  .bind-cell button.cell-btn {
    font: inherit; font-size: 0.72rem; border: 1px solid var(--me-gray);
    background: #fff; color: var(--me-dark); border-radius: 2px; cursor: pointer; padding: 1px 6px;
  }
  .bind-cell button.cell-btn:hover { background: var(--me-red); border-color: var(--me-red); color: #fff; }
  .bind-cell .cell-bar { height: 4px; background: var(--me-light); border-radius: 2px; overflow: hidden; }
  .bind-cell .cell-fill { height: 100%; width: 50%; background: var(--me-blue); }
  .bind-empty-msg { grid-column: 1 / -1; padding: 1rem; text-align: center; color: var(--me-mid); }
`;
document.head.appendChild(style);

/**
 * Ready-screen tutorial text per input source.
 * @type {Record<'touch' | 'gamepad' | 'keyboard', string[]>}
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
    'Open Advanced Binding for split HOTAS rigs, reversing an axis, or range calibration.',
  ],
  keyboard: [
    'W / S throttle · A / D yaw · Arrow keys pitch / roll.',
    'R reset · C camera · G god mode · O OSD.',
    'Connect a gamepad and pick a preset above for full stick control.',
  ],
};

/** Display label per channel for the grid's row headers. */
const CHANNEL_LABELS = { throttle: 'Throttle', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };

/** Set a select's value only if that option actually exists. */
function setSelect(select, value) {
  if (Array.from(select.options).some((o) => o.value === value)) select.value = value;
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
    this.bindStatus = document.getElementById('bind-status');
    this.bindDone = document.getElementById('bind-done');
    this.bindClear = document.getElementById('bind-clear');

    this.capture = new AxisCapture();
    this.calibrator = new AxisCalibrator();
    /** @type {{channel: string, deviceId: string} | null} Cell being (re)bound. */
    this.capturingCell = null;
    /** @type {{channel: string, deviceId: string} | null} Cell being calibrated. */
    this.calibratingCell = null;
    /** @type {Map<string, {fill: HTMLElement, id: string, axis: number}>} Live bars per channel. */
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
      if (e.code === 'Escape' && !this.ratesOverlay.hidden) this.ratesOverlay.hidden = true;
    });

    this.advancedBind.addEventListener('click', () => this.openGrid());
    this.bindDone.addEventListener('click', () => this.closeGrid());
    this.bindClear.addEventListener('click', () => {
      this.capture.cancel();
      this.calibrator.cancel();
      this.capturingCell = null;
      this.calibratingCell = null;
      this.input.clearBindings();
      this.preset = null;
      this.onSettingsChange();
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
  }

  /** True while the binding grid is open (arming must wait). */
  isBusy() {
    return !this.bindingOverlay.hidden;
  }

  /** No ready-screen preview needed; the grid shows its own live bars. */
  previewControls() {
    return null;
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
      this.input.applyPreset(v);
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
    let status;
    if (this.input.forceKeyboard) status = 'Keyboard controls active.';
    else if (this.preset === 'custom') status = 'Custom axis bindings — open Advanced Binding to edit.';
    else if (this.preset) status = `Preset: ${label(this.preset)}.`;
    else if (pad) status = `Auto preset: ${label(defaultPresetFor(pad))} — pick one or bind to customize.`;
    else status = 'No controller detected — keyboard fallback active.';
    this.inputStatus.textContent = status;

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

  /** Rebuild the ready-screen tutorial list and the Advanced button visibility. */
  updateTutorial() {
    const source = this.effectiveSource();
    this.readyTutorial.innerHTML = '';
    for (const text of TUTORIALS[source]) {
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

  /** Rebuild the grid DOM from the connected devices and current bindings. */
  renderGrid() {
    const grid = this.bindGrid;
    grid.innerHTML = '';
    this.cellBars = new Map();
    const devices = this.input.listGamepads();

    if (devices.length === 0) {
      grid.style.gridTemplateColumns = '1fr';
      const msg = document.createElement('div');
      msg.className = 'bind-empty-msg';
      msg.textContent = 'No controllers detected. Connect one and move an axis to wake it.';
      grid.appendChild(msg);
      this.bindStatus.textContent = '';
      return;
    }

    grid.style.gridTemplateColumns = `minmax(64px, max-content) repeat(${devices.length}, minmax(158px, 1fr))`;
    const corner = document.createElement('div');
    corner.className = 'bind-corner';
    grid.appendChild(corner);
    for (const d of devices) {
      const head = document.createElement('div');
      head.className = 'bind-devhead';
      head.textContent = `${d.index}: ${d.id}`;
      head.title = d.id;
      grid.appendChild(head);
    }

    const bindings = this.currentBindings();
    for (const channel of CHANNELS) {
      const rowLabel = document.createElement('div');
      rowLabel.className = 'bind-rowlabel';
      rowLabel.textContent = CHANNEL_LABELS[channel];
      grid.appendChild(rowLabel);
      for (const d of devices) grid.appendChild(this.renderCell(channel, d, bindings[channel]));
    }
  }

  /**
   * One grid cell for (channel, device).
   * @param {string} channel Control channel.
   * @param {{index: number, id: string}} device Column device.
   * @param {import('./axisbind.js').AxisBinding | undefined} binding This channel's binding.
   * @returns {HTMLElement}
   */
  renderCell(channel, device, binding) {
    const cell = document.createElement('div');
    cell.className = 'bind-cell';
    const bound = binding && binding.id === device.id;
    const capturing = this.capturingCell?.channel === channel && this.capturingCell?.deviceId === device.id;
    const calibrating = this.calibratingCell?.channel === channel && this.calibratingCell?.deviceId === device.id;
    const busy = this.capture.active || this.calibrator.active;

    if (capturing) {
      cell.className = 'bind-cell active';
      cell.textContent = 'Move the axis and hold…';
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
    axisLabel.textContent = `Axis ${binding.axis}${binding.range ? ' ✓' : ''}`;
    axisLabel.title = 'Click to rebind this control';
    axisLabel.disabled = busy;
    axisLabel.addEventListener('click', () => this.beginCapture(channel, device.id));

    const actions = document.createElement('div');
    actions.className = 'cell-actions';

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
    calBtn.textContent = calibrating ? 'Finish' : 'Cal';
    calBtn.addEventListener('click', () =>
      calibrating ? this.finishCalibration() : this.beginCalibration(channel, device.id, binding)
    );

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cell-btn';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear this binding';
    clearBtn.disabled = busy;
    clearBtn.addEventListener('click', () => this.clearCell(channel));

    actions.append(rev, calBtn, clearBtn);

    const bar = document.createElement('div');
    bar.className = 'cell-bar';
    const fill = document.createElement('div');
    fill.className = 'cell-fill';
    bar.appendChild(fill);
    this.cellBars.set(channel, { fill, id: binding.id, axis: binding.axis });

    cell.append(axisLabel, actions, bar);
    return cell;
  }

  /**
   * Start capturing an axis on a device for a channel.
   * @param {string} channel Control channel.
   * @param {string} deviceId Target device id.
   */
  beginCapture(channel, deviceId) {
    if (this.capture.active || this.calibrator.active) return;
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
    if (this.capture.active || this.calibrator.active) return;
    const base = { ...this.currentBindings() };
    delete base[channel];
    if (Object.keys(base).length === 0) {
      this.input.clearBindings();
      this.preset = null;
      this.onSettingsChange();
    } else {
      this.input.setBindings(base);
      this.markCustom();
    }
    this.renderGrid();
  }

  /**
   * Start range calibration for a bound cell.
   * @param {string} channel Control channel.
   * @param {string} deviceId Device id.
   * @param {import('./axisbind.js').AxisBinding} binding Cell binding.
   */
  beginCalibration(channel, deviceId, binding) {
    if (this.capture.active || this.calibrator.active) return;
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

  /** Update the live fill bars for every bound cell from current axis values. */
  updateBars() {
    if (this.cellBars.size === 0) return;
    const pads = navigator.getGamepads();
    for (const { fill, id, axis } of this.cellBars.values()) {
      const pad = Array.from(pads).find((p) => p && p.id === id);
      const v = pad && pad.axes[axis] !== undefined ? pad.axes[axis] : 0;
      fill.style.width = `${((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100}%`;
    }
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
