/**
 * Camera rig: positions the shared perspective camera for the three view modes
 * (Chase, FPV, Top) and runs the crash-cam dolly-back. Owns only the scratch
 * math objects and the FPV uptilt; the camera, drone, and flight state are
 * supplied by the caller so the game loop stays the single source of truth.
 */

import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Distance the crash-cam pulls back from the frozen FPV impact pose. */
const CRASH_CAM_PULLBACK = new THREE.Vector3(0, 1.5, 4);

/** Drives the shared camera; see module comment. */
export class CameraRig {
  /**
   * @param {THREE.PerspectiveCamera} camera Shared scene camera.
   * @param {object} refs DOM controls.
   * @param {HTMLSelectElement} refs.modeSelect Camera-mode dropdown.
   * @param {HTMLInputElement} refs.pitchSlider FPV uptilt slider (degrees).
   * @param {HTMLElement} refs.pitchValue Label showing the slider value.
   */
  constructor(camera, { modeSelect, pitchSlider, pitchValue }) {
    this.camera = camera;
    this.modeSelect = modeSelect;
    this.pitchSlider = pitchSlider;
    this.pitchValue = pitchValue;

    // FPV camera uptilt, like the fixed camera angle on a real FPV quad.
    // Precomputed as a quaternion so the frame loop just multiplies.
    this.fpvTilt = new THREE.Quaternion();
    // Soft-follow target for Chase mode.
    this.cameraTarget = new THREE.Vector3();
    // Crash-cam scratch.
    this._crashTargetPos = new THREE.Vector3();
    this._crashMatrix = new THREE.Matrix4();
    this._crashQuat = new THREE.Quaternion();

    pitchSlider.addEventListener('input', () => this.syncPitch());
    this.syncPitch();
  }

  /** @returns {string} The active camera mode value. */
  get mode() {
    return this.modeSelect.value;
  }

  /** Refresh the FPV tilt quaternion and its label from the settings slider. */
  syncPitch() {
    const deg = Number(this.pitchSlider.value);
    this.pitchValue.textContent = `${deg}°`;
    this.fpvTilt.setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(deg));
  }

  /**
   * Position the camera for the selected mode. Also toggles the airframe mesh
   * visibility (hidden in FPV, shown otherwise and during the crash reveal).
   * @param {import('./drone.js').Drone} drone
   * @param {object} state
   * @param {'ready'|'flying'|'crashed'|'results'} state.flightState
   * @param {number} state.crashTimer Seconds left in the crash animation.
   * @param {number} state.crashDuration Total crash-animation length.
   * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion}|null} state.crashCamOrigin
   *   Frozen FPV pose at impact, or null when the crash wasn't in FPV.
   */
  update(drone, { flightState, crashTimer, crashDuration, crashCamOrigin }) {
    const { camera } = this;

    if (flightState === 'crashed' && crashCamOrigin) {
      // Dolly back from the frozen FPV impact pose over the crash duration,
      // revealing the drone (and whatever it hit) instead of a static wall
      // of building texture filling the screen.
      const t = 1 - Math.max(0, crashTimer) / crashDuration;
      const ease = t * t * (3 - 2 * t);
      drone.mesh.visible = true;
      this._crashTargetPos
        .copy(CRASH_CAM_PULLBACK)
        .applyQuaternion(crashCamOrigin.quaternion)
        .add(crashCamOrigin.position);
      camera.position.lerpVectors(crashCamOrigin.position, this._crashTargetPos, ease);
      this._crashMatrix.lookAt(camera.position, drone.position, WORLD_UP);
      this._crashQuat.setFromRotationMatrix(this._crashMatrix);
      camera.quaternion.copy(crashCamOrigin.quaternion).slerp(this._crashQuat, ease);
      return;
    }

    const mode = this.mode;
    // Hide the airframe in FPV so the canopy doesn't block the view.
    drone.mesh.visible = mode !== 'fpv';
    if (mode === 'fpv') {
      camera.position.copy(drone.position);
      // Camera and drone both face their local -Z, so the orientations match
      // 1:1; the configured uptilt is then applied in the drone's local frame.
      camera.quaternion.copy(drone.mesh.quaternion).multiply(this.fpvTilt);
      return;
    }
    if (mode === 'top') {
      camera.position.set(drone.position.x, 45, drone.position.z + 0.01);
      camera.lookAt(drone.position);
      return;
    }
    // Chase: sit behind the drone based on yaw only, with soft follow.
    const offset = new THREE.Vector3(0, 2.2, 5.5).applyEuler(new THREE.Euler(0, drone.yaw, 0));
    camera.position.lerp(drone.position.clone().add(offset), 0.12);
    this.cameraTarget.lerp(drone.position, 0.25);
    camera.lookAt(this.cameraTarget);
  }
}
