/**
 * Ready-screen input configuration UI: device selector, calibration wizard,
 * multi-device axis binding, and rates/expo. Owns every input-settings DOM
 * element and its wiring, so the main entry point keeps only three seams into
 * it — {@link ControlsUI#update}, {@link ControlsUI#isBusy}, and
 * {@link ControlsUI#previewControls} — plus settings persistence delegation.
 */

import { AxisBinder } from './axisbind.js';
import { CalibrationWizard } from './calibration.js';
import { expoCurve } from './input.js';

/**
 * Ready-screen tutorial text per input source. Touch always uses the on-screen
 * pads; the others depend on the selector and whether a pad is connected.
 * @type {Record<'touch' | 'gamepad' | 'keyboard', string[]>}
 */
const TUTORIALS = {
  touch: [
    'Left stick — throttle (up / down) and yaw (turn). Throttle holds when you lift your thumb.',
    'Right stick — pitch (forward / back) and roll (bank). Springs back to center.',
    'Tap Start Flying, then race through the gates.',
  ],
  gamepad: [
    'RadioMaster: plug in via USB, select "USB Joystick (HID)", move a stick to connect.',
    'Sticks map to throttle / yaw / pitch / roll per the Channel Map or your calibration.',
    'Run Calibrate Controller once if any axis is reversed or off-center.',
  ],
  keyboard: [
    'W / S throttle · A / D yaw · Arrow keys pitch / roll.',
    'R reset · C camera · G god mode · O OSD.',
    'Connect a gamepad and pick it above for full stick control.',
  ],
};

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

    this.inputDevice = document.getElementById('input-device');
    this.channelMap = document.getElementById('channel-map');
    this.readyTutorial = document.getElementById('ready-tutorial');
    this.calibrateButton = document.getElementById('calibrate-button');
    this.bindButton = document.getElementById('bind-button');
    this.calibrationStatus = document.getElementById('calibration-status');
    this.ratesButton = document.getElementById('rates-button');
    this.ratesOverlay = document.getElementById('rates-overlay');
    this.ratesDone = document.getElementById('rates-done');
    this.expoSlider = document.getElementById('expo-slider');
    this.expoValue = document.getElementById('expo-value');
    this.yawExpoSlider = document.getElementById('yaw-expo-slider');
    this.yawExpoValue = document.getElementById('yaw-expo-value');
    this.expoCanvas = document.getElementById('expo-curve');
    this.calibrationOverlay = document.getElementById('calibration-overlay');
    this.calibInstruction = document.getElementById('calib-instruction');
    this.calibAxes = document.getElementById('calib-axes');
    this.calibStatus = document.getElementById('calib-status');
    this.calibNext = document.getElementById('calib-next');
    this.calibCancel = document.getElementById('calib-cancel');
    this.calibClear = document.getElementById('calib-clear');
    this.bindingOverlay = document.getElementById('binding-overlay');
    this.bindInstruction = document.getElementById('bind-instruction');
    this.bindStatus = document.getElementById('bind-status');
    this.bindNext = document.getElementById('bind-next');
    this.bindCancel = document.getElementById('bind-cancel');
    this.bindClear = document.getElementById('bind-clear');

    this.wizard = new CalibrationWizard(
      input,
      {
        overlay: this.calibrationOverlay,
        instruction: this.calibInstruction,
        axesContainer: this.calibAxes,
        status: this.calibStatus,
        nextButton: this.calibNext,
      },
      () => this.syncCalibrationUi()
    );

    this.binder = new AxisBinder(
      input,
      {
        overlay: this.bindingOverlay,
        instruction: this.bindInstruction,
        status: this.bindStatus,
        nextButton: this.bindNext,
      },
      () => this.updateTutorial()
    );

    input.onDevicesChange = () => this.populateInputDevices();
    this.inputDevice.addEventListener('change', () => this.syncInputDevice());
    this.channelMap.addEventListener('change', (e) => {
      this.input.channelMap = e.target.value;
    });

    this.ratesButton.addEventListener('click', () => {
      this.drawExpoCurve();
      this.ratesOverlay.hidden = false;
    });
    this.ratesDone.addEventListener('click', () => { this.ratesOverlay.hidden = true; });
    this.expoSlider.addEventListener('input', () => this.syncRates());
    this.yawExpoSlider.addEventListener('input', () => this.syncRates());
    // Persist on release rather than every drag tick.
    this.ratesOverlay.addEventListener('change', () => this.onSettingsChange());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && !this.ratesOverlay.hidden) this.ratesOverlay.hidden = true;
    });

    this.calibrateButton.addEventListener('click', () => this.wizard.start());
    this.calibNext.addEventListener('click', () => this.wizard.next());
    this.calibCancel.addEventListener('click', () => this.wizard.cancel());
    this.calibClear.addEventListener('click', () => {
      this.input.clearCalibration();
      this.wizard.cancel();
    });

    this.bindButton.addEventListener('click', () => this.binder.start());
    this.bindNext.addEventListener('click', () => this.binder.next());
    this.bindCancel.addEventListener('click', () => this.binder.cancel());
    this.bindClear.addEventListener('click', () => {
      this.input.clearBindings();
      this.binder.cancel();
    });
  }

  /** Initial UI sync; call once after settings are loaded. */
  init() {
    this.populateInputDevices();
    this.syncCalibrationUi();
    this.syncRates();
  }

  /**
   * Per-frame update for the active overlay (calibration / binding).
   * @param {number} dt Frame delta time in seconds.
   */
  update(dt) {
    this.wizard.update(dt);
    this.binder.update(dt);
  }

  /** True while a configuration overlay is open (arming must wait). */
  isBusy() {
    return this.wizard.active || this.binder.active;
  }

  /**
   * Preview control input while the calibration wizard is open, so the ready
   * screen's sticks reflect the in-progress calibration. Null otherwise, so
   * the caller falls back to the live poll.
   * @returns {import('./input.js').ControlInput | null}
   */
  previewControls() {
    return this.wizard.active ? this.wizard.previewControls() : null;
  }

  /**
   * Effective input source given the selector value and connected hardware.
   * On touch devices the on-screen pads are always the working source.
   * @returns {'touch' | 'gamepad' | 'keyboard'}
   */
  effectiveSource() {
    const v = this.inputDevice.value;
    if (v !== 'keyboard' && (v !== 'auto' || this.input.listGamepads().length > 0)) return 'gamepad';
    return this.isTouch ? 'touch' : 'keyboard';
  }

  /** Rebuild the ready-screen tutorial and calibration UI for the current source. */
  updateTutorial() {
    const source = this.effectiveSource();
    this.readyTutorial.innerHTML = '';
    for (const text of TUTORIALS[source]) {
      const li = document.createElement('li');
      li.textContent = text;
      this.readyTutorial.appendChild(li);
    }
    // Calibration only applies to a physical gamepad.
    this.calibrateButton.hidden = source !== 'gamepad';
    this.calibrationStatus.hidden = source !== 'gamepad';
    // Multi-device binding is for physical controller rigs, not the touch pads.
    this.bindButton.hidden = this.isTouch;
    this.bindButton.textContent = this.input.hasBindings()
      ? 'Re-bind Axes (Multi-Device)'
      : 'Bind Axes (Multi-Device)';
  }

  /** Push the selected device value into the input manager and refresh the UI. */
  syncInputDevice() {
    const v = this.inputDevice.value;
    this.input.selectInput(v === 'auto' || v === 'keyboard' ? v : Number(v));
    this.updateTutorial();
  }

  /**
   * Rebuild the device dropdown from the connected gamepads, preserving the
   * current choice when it's still available (otherwise falling back to Auto).
   * The two static options (Auto / Keyboard) are kept; only the dynamic
   * per-gamepad entries are refreshed.
   */
  populateInputDevices() {
    const prev = this.inputDevice.value;
    this.inputDevice.querySelectorAll('option[data-pad]').forEach((o) => o.remove());
    for (const { index, id } of this.input.listGamepads()) {
      const opt = document.createElement('option');
      opt.value = String(index);
      opt.dataset.pad = '1';
      opt.textContent = `${index}: ${id}`;
      this.inputDevice.appendChild(opt);
    }
    this.inputDevice.value = Array.from(this.inputDevice.options).some((o) => o.value === prev)
      ? prev
      : 'auto';
    this.syncInputDevice();
  }

  /** Sync the channel-map select and ready-screen status with input state. */
  syncCalibrationUi() {
    this.channelMap.value = this.input.channelMap;
    this.calibrationStatus.textContent = this.input.calibration
      ? 'Saved calibration found — Channel Map is set to Custom.'
      : 'No saved calibration — using the AETR default map.';
  }

  /** Redraw the expo-curve preview: linear reference plus both active curves. */
  drawExpoCurve() {
    const ctx = this.expoCanvas.getContext('2d');
    const w = this.expoCanvas.width;
    const h = this.expoCanvas.height;
    const pad = 12;
    const toX = (v) => pad + ((v + 1) / 2) * (w - pad * 2);
    const toY = (v) => h - pad - ((v + 1) / 2) * (h - pad * 2);

    ctx.clearRect(0, 0, w, h);

    // Center axes.
    ctx.strokeStyle = '#C9D1D6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(toX(-1), toY(0));
    ctx.lineTo(toX(1), toY(0));
    ctx.moveTo(toX(0), toY(-1));
    ctx.lineTo(toX(0), toY(1));
    ctx.stroke();

    // Linear reference.
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

    // Legend.
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

  /**
   * Input-related fields for settings persistence.
   * @returns {{inputDevice: string, channelMap: string, expo: string, yawExpo: string}}
   */
  collectSettings() {
    return {
      inputDevice: this.inputDevice.value,
      channelMap: this.channelMap.value,
      expo: this.expoSlider.value,
      yawExpo: this.yawExpoSlider.value,
    };
  }

  /**
   * Restore input-related settings into the controls and the input manager.
   * @param {Record<string, unknown>} s Parsed settings blob.
   */
  applySettings(s) {
    // Only 'auto'/'keyboard' are stable across sessions; a saved gamepad index
    // has no matching option yet at load, so setSelect harmlessly ignores it
    // and populateInputDevices() re-applies it if the pad is still present.
    if (typeof s.inputDevice === 'string') setSelect(this.inputDevice, s.inputDevice);
    // Only restore CUSTOM if a calibration actually exists this session.
    if (typeof s.channelMap === 'string' && (s.channelMap !== 'CUSTOM' || this.input.calibration)) {
      setSelect(this.channelMap, s.channelMap);
    }
    if (s.expo !== undefined && Number.isFinite(Number(s.expo))) {
      this.expoSlider.value = String(s.expo);
    }
    if (s.yawExpo !== undefined && Number.isFinite(Number(s.yawExpo))) {
      this.yawExpoSlider.value = String(s.yawExpo);
    }
    this.input.channelMap = this.channelMap.value;
  }
}
