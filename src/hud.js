/**
 * In-flight instrument overlays: the FPV OSD (artificial horizon + speed/alt),
 * the Gate Rush and Strike HUD bars, and the dual stick indicators. Owns its
 * own DOM refs and the little bit of display state (bomb-pop tracking, OSD
 * visibility); dynamic game state is passed into each method by the game loop.
 */

import * as THREE from 'three';

import { DRONE_HP, BOMB_MAX } from './strike.js';

/**
 * Format a duration as M:SS.
 * @param {number} seconds Seconds remaining (clamped at 0).
 * @returns {string}
 */
function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Renders the instrument overlays; see module comment. */
export class Hud {
  /**
   * @param {object} refs DOM elements for every overlay this owns.
   */
  constructor(refs) {
    this.refs = refs;
    /** Last-seen bomb stock, so the icon pops exactly once on recharge. */
    this._prevBombStock = 0;
    /** True while the OSD is enabled AND the drone is flying. */
    this.osdVisible = false;
    /** Scratch vector for the gate bearing calculation. */
    this._camDir = new THREE.Vector3();
  }

  /**
   * OSD is an in-flight instrument: visible only when enabled AND flying.
   * @param {boolean} enabled OSD toggle state.
   * @param {boolean} flying Whether the drone is currently flying.
   */
  syncOsdVisibility(enabled, flying) {
    this.osdVisible = enabled && flying;
    this.refs.osd.hidden = !this.osdVisible;
  }

  /**
   * Refresh the OSD horizon and readouts from the drone state, once per frame.
   * @param {import('./drone.js').Drone} drone
   * @param {THREE.PerspectiveCamera} camera For the vertical FOV.
   */
  updateOsd(drone, camera) {
    const { osdHorizon, osdSpeedValue, osdAltValue } = this.refs;
    // Artificial horizon: rotate with roll, shift along the rolled vertical
    // with pitch (screen px per degree derived from the vertical FOV).
    const pxPerDeg = window.innerHeight / camera.fov;
    const rollDeg = THREE.MathUtils.radToDeg(drone.roll);
    const maxShift = window.innerHeight * 0.32;
    const pitchPx = Math.max(
      -maxShift,
      Math.min(maxShift, THREE.MathUtils.radToDeg(drone.pitch) * pxPerDeg)
    );
    osdHorizon.style.transform =
      `translate(-50%, -50%) rotate(${rollDeg.toFixed(1)}deg) translateY(${pitchPx.toFixed(1)}px)`;

    osdSpeedValue.textContent = drone.speed().toFixed(1);
    osdAltValue.textContent = drone.position.y.toFixed(1);
  }

  /**
   * Toggle Gate Rush HUD visibility.
   * @param {boolean} on
   */
  showGate(on) {
    this.refs.gateHud.hidden = !on;
  }

  /**
   * Toggle Strike HUD + bomb-drop button visibility together.
   * @param {boolean} on
   */
  showStrike(on) {
    this.refs.strikeHud.hidden = !on;
    this.refs.dropButton.hidden = !on;
  }

  /**
   * Seed the bomb-pop tracker from a freshly built mission so the opening
   * stock doesn't trigger a spurious pop, then draw the initial HUD.
   * @param {import('./strike.js').StrikeMission} strike
   */
  primeStrike(strike) {
    this._prevBombStock = strike.bombStock;
    this.updateStrike(strike);
  }

  /** Flash the HP bar red on a hit (restarts even mid-animation). */
  flashStrikeHit() {
    const { strikeHud } = this.refs;
    strikeHud.classList.remove('hit');
    void strikeHud.offsetWidth;
    strikeHud.classList.add('hit');
  }

  /**
   * Refresh the Strike HUD: enemies left, the HP glyph bar, and the bottom-center
   * bomb icon. While the stock is below capacity the icon darkens and refills
   * bottom-up over the recharge; the red badge shows the ready count and the icon
   * pops each time a bomb finishes charging.
   * @param {import('./strike.js').StrikeMission} strike
   */
  updateStrike(strike) {
    const { strikeEnemies, strikeHp, dropButton, dropCount } = this.refs;
    strikeEnemies.textContent = `ENEMIES ${strike.enemiesLeft}`;
    const hp = strike.droneHp;
    strikeHp.innerHTML =
      `HP ${'█'.repeat(hp)}<span class="spent">${'█'.repeat(DRONE_HP - hp)}</span>`;

    const stock = strike.bombStock;
    const charging = stock < BOMB_MAX;
    dropButton.classList.toggle('charging', charging);
    dropButton.style.setProperty('--p', charging ? strike.regenProgress.toFixed(3) : '0');
    dropCount.textContent = String(stock);
    dropButton.disabled = stock <= 0;

    if (stock > this._prevBombStock) {
      dropButton.classList.remove('pop');
      void dropButton.offsetWidth;
      dropButton.classList.add('pop');
    }
    this._prevBombStock = stock;
  }

  /**
   * Refresh the gate HUD: score, distance, and bearing arrow.
   * @param {import('./gates.js').GateCourse} course
   * @param {import('./drone.js').Drone} drone
   * @param {THREE.PerspectiveCamera} camera
   * @param {number} timeLeft Seconds remaining in the run.
   */
  updateGate(course, drone, camera, timeLeft) {
    const { gateArrow, gateInfo, gateTimer } = this.refs;
    const target = course.target;
    camera.getWorldDirection(this._camDir);
    const camDir = this._camDir;
    const dx = target.x - camera.position.x;
    const dz = target.z - camera.position.z;
    // Signed angle from camera forward to the gate (clockwise positive),
    // so the arrow points where the player must turn.
    const rel = Math.atan2(camDir.x * dz - camDir.z * dx, camDir.x * dx + camDir.z * dz);
    // The ➤ glyph points right, so offset by -90° to make it point up (toward
    // the gate) when it lies straight ahead.
    gateArrow.style.transform = `rotate(${(((rel * 180) / Math.PI) - 90).toFixed(1)}deg)`;
    gateInfo.textContent = `GATES ${course.score} | ${target.distanceTo(drone.position).toFixed(0)} m`;
    gateTimer.textContent = formatTime(timeLeft);
    gateTimer.classList.toggle('urgent', timeLeft < 10);
  }

  /**
   * Mirror stick input onto the two on-screen indicators.
   * @param {import('./input.js').ControlInput} controls
   */
  updateSticks(controls) {
    setStick(this.refs.stickLeft, controls.yaw, controls.throttle * 2 - 1);
    setStick(this.refs.stickRight, controls.roll, controls.pitch);
  }
}

/**
 * Move a stick indicator dot.
 * @param {HTMLElement} dot Indicator element.
 * @param {number} x Horizontal input in [-1, 1].
 * @param {number} y Vertical input in [-1, 1] (up = +1).
 */
function setStick(dot, x, y) {
  dot.style.transform = `translate(calc(-50% + ${x * 24}px), calc(-50% + ${-y * 24}px))`;
}
