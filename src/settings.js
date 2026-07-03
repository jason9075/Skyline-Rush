/**
 * Settings persistence: snapshots the modal's controls to localStorage and
 * restores them on load, pushing the restored values into the systems that
 * consume them (drone flight mode, controls UI). Dependent UI is re-synced by
 * the caller via its usual sync* helpers after {@link SettingsStore#load}.
 */

import { setSelect } from './input.js';

const SETTINGS_KEY = 'drone-control.settings';

/** Reads/writes the persisted settings blob; see module comment. */
export class SettingsStore {
  /**
   * @param {object} refs Settings controls.
   * @param {HTMLSelectElement} refs.flightMode
   * @param {HTMLSelectElement} refs.gameMode
   * @param {HTMLSelectElement} refs.difficulty
   * @param {HTMLSelectElement} refs.cameraMode
   * @param {HTMLInputElement} refs.cameraPitch
   * @param {HTMLInputElement} refs.godModeCheckbox
   * @param {HTMLInputElement} refs.osdCheckbox
   * @param {import('./controls-ui.js').ControlsUI} controlsUi
   * @param {import('./drone.js').Drone} drone
   */
  constructor(refs, controlsUi, drone) {
    this.refs = refs;
    this.controlsUi = controlsUi;
    this.drone = drone;
  }

  /** Snapshot every settings control into localStorage. */
  save() {
    const { flightMode, gameMode, difficulty, cameraMode, cameraPitch, godModeCheckbox, osdCheckbox } = this.refs;
    const settings = {
      flightMode: flightMode.value,
      gameMode: gameMode.value,
      difficulty: difficulty.value,
      cameraMode: cameraMode.value,
      cameraPitch: cameraPitch.value,
      godMode: godModeCheckbox.checked,
      osd: osdCheckbox.checked,
      ...this.controlsUi.collectSettings(),
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      console.warn('Failed to persist settings:', err);
    }
  }

  /**
   * Restore saved settings into the controls and push them into the systems
   * that consume them (drone, controls UI). No-op when nothing is stored.
   */
  load() {
    const { flightMode, gameMode, difficulty, cameraMode, cameraPitch, godModeCheckbox, osdCheckbox } = this.refs;
    let s = null;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) s = JSON.parse(raw);
    } catch (err) {
      console.warn('Failed to load settings:', err);
    }
    if (!s) return;
    if (typeof s.flightMode === 'string') setSelect(flightMode, s.flightMode);
    if (typeof s.gameMode === 'string') setSelect(gameMode, s.gameMode);
    if (typeof s.difficulty === 'string') setSelect(difficulty, s.difficulty);
    if (typeof s.cameraMode === 'string') setSelect(cameraMode, s.cameraMode);
    if (s.cameraPitch !== undefined && Number.isFinite(Number(s.cameraPitch))) {
      cameraPitch.value = String(s.cameraPitch);
    }
    if (typeof s.godMode === 'boolean') godModeCheckbox.checked = s.godMode;
    if (typeof s.osd === 'boolean') osdCheckbox.checked = s.osd;
    this.controlsUi.applySettings(s);

    this.drone.flightMode = flightMode.value;
  }
}
