import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import hdrSkyUrl from '../assets/kloofendal_48d_partly_cloudy_puresky_1k.hdr?url';
import { loadBuildingPool } from './buildings.js';
import { CalibrationWizard } from './calibration.js';
import { Drone, DRONE_RADIUS } from './drone.js';
import { InputManager } from './input.js';
import { World } from './world.js';

/* ─── Mirror's Edge colour palette & layout ───────────────────────── */
const style = document.createElement('style');
style.textContent = `
  :root {
    --me-white: #FAFBFC; --me-panel: #FFFFFF; --me-light: #EDF1F3;
    --me-gray: #C9D1D6; --me-mid: #5A6468; --me-dark: #1B1E20;
    --me-red: #E0301E; --me-red-dark: #B22415;
    --me-orange: #F39C12; --me-blue: #4FA3D9;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--me-white); color: var(--me-dark);
    font-family: 'Helvetica Neue', 'Arial', sans-serif;
    overflow: hidden;
  }
  canvas { display: block; }
  #info {
    position: absolute; top: 1rem; left: 1rem;
    color: var(--me-dark); font-size: 0.85rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; z-index: 10;
  }
  #info::before { content: ''; display: inline-block; width: 0.6em; height: 0.6em;
    background: var(--me-red); margin-right: 0.5em; }
  /* Topmost layer (above the ready/calibration overlays at 40/45 and the
     HUD at 46) so settings stay adjustable on the start screen. */
  #toolbar {
    position: fixed; top: 1rem; right: 1rem;
    display: flex; gap: 0.75rem; align-items: center;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--me-gray); border-radius: 2px;
    background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(10px);
    z-index: 47; font-size: 0.85rem;
  }
  #toolbar label { font: inherit; color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em; }
  #toolbar select, #toolbar button {
    font: inherit; border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-panel); color: var(--me-dark);
    padding: 0.4rem 0.7rem; cursor: pointer;
  }
  #toolbar button:hover { background: var(--me-red); border-color: var(--me-red); color: #fff; }
  .toggle-label {
    display: flex; align-items: center; gap: 0.35rem; cursor: pointer;
    color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em;
  }
  .toggle-label input { accent-color: var(--me-red); cursor: pointer; }
  /* Above the ready/calibration overlays (40/45) so the sticks stay visible
     for verifying the RC controller before starting. */
  #hud {
    position: fixed; bottom: 1rem; left: 1rem; z-index: 46;
    display: grid; gap: 0.5rem; font-size: 0.8rem;
  }
  #gamepad-status { color: var(--me-red); font-weight: 700; }
  #telemetry { color: var(--me-dark); font-family: monospace; }
  #help-text { color: var(--me-mid); max-width: 34rem; line-height: 1.5; }
  #sticks { display: flex; gap: 0.75rem; }
  .stick {
    position: relative; width: 64px; height: 64px;
    border: 1px solid var(--me-gray); border-radius: 2px;
    background: rgba(255, 255, 255, 0.85);
  }
  .stick-dot {
    position: absolute; left: 50%; top: 50%; width: 10px; height: 10px;
    border-radius: 50%; background: var(--me-red);
    transform: translate(-50%, -50%);
  }
  #crash-banner {
    position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%);
    color: var(--me-red); font-size: 2.4rem; font-weight: 800;
    letter-spacing: 0.12em; text-transform: uppercase; z-index: 30;
  }
  #crash-banner[hidden] { display: none; }
  #ready-overlay {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(250, 251, 252, 0.65); backdrop-filter: blur(4px); z-index: 40;
  }
  #ready-overlay[hidden] { display: none; }
  .ready-panel {
    width: min(520px, calc(100vw - 2rem)); padding: 2rem;
    background: var(--me-panel); border: 1px solid var(--me-gray); border-radius: 2px;
    border-top: 4px solid var(--me-red);
    box-shadow: 0 20px 60px rgba(27, 30, 32, 0.18);
    display: grid; gap: 1rem; text-align: center;
  }
  .ready-panel h1 {
    font-size: 1.3rem; color: var(--me-dark);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .ready-panel p { color: var(--me-dark); line-height: 1.6; }
  .ready-panel ul {
    list-style: none; text-align: left; display: grid; gap: 0.4rem;
    color: var(--me-mid); font-size: 0.85rem; line-height: 1.5;
  }
  .ready-panel ul li::before { content: '›'; color: var(--me-red); margin-right: 0.5rem; }
  #arm-hint { color: var(--me-orange); font-size: 0.9rem; font-weight: 700; }
  #arm-hint[hidden] { display: none; }
  #loading-text { color: var(--me-mid); font-size: 0.85rem; }
  #loading-text[hidden] { display: none; }
  #start-button {
    justify-self: center; font: inherit; font-size: 1rem; cursor: pointer;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 0.7rem 2.2rem; border-radius: 2px;
    border: 1px solid var(--me-red); background: var(--me-red); color: #fff;
  }
  #start-button:hover { background: var(--me-red-dark); border-color: var(--me-red-dark); }
  #start-button:disabled { background: var(--me-gray); border-color: var(--me-gray); cursor: wait; }
  .ready-footnote { color: var(--me-mid); font-size: 0.75rem; }
  .secondary-button {
    justify-self: center; font: inherit; font-size: 0.85rem; cursor: pointer;
    padding: 0.5rem 1.4rem; border-radius: 2px;
    border: 1px solid var(--me-gray); background: var(--me-panel); color: var(--me-dark);
  }
  .secondary-button:hover { border-color: var(--me-red); color: var(--me-red); }
  #calibration-overlay {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(250, 251, 252, 0.65); backdrop-filter: blur(4px); z-index: 45;
  }
  #calibration-overlay[hidden] { display: none; }
  #calib-instruction { min-height: 3em; }
  #calib-status { color: var(--me-orange); font-size: 0.8rem; min-height: 1.2em; font-weight: 700; }
  #calib-axes { display: grid; gap: 0.35rem; }
  .calib-axis {
    display: grid; grid-template-columns: 2.2rem 1fr; align-items: center;
    gap: 0.5rem; font-size: 0.75rem; color: var(--me-mid); font-family: monospace;
  }
  .calib-track {
    height: 10px; border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-light); overflow: hidden;
  }
  .calib-fill {
    height: 100%; width: 50%; background: var(--me-blue);
    transition: width 0.05s linear;
  }
  .calib-fill.assigned { background: var(--me-red); }
  .calib-actions { display: flex; gap: 0.5rem; justify-content: center; }
  .calib-actions button { font: inherit; }
  #calib-next {
    cursor: pointer; padding: 0.5rem 1.4rem; border-radius: 2px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    border: 1px solid var(--me-red); background: var(--me-red); color: #fff;
  }
  #calib-next:hover { background: var(--me-red-dark); }
  #calib-next[hidden] { display: none; }
`;
document.head.appendChild(style);

/* ─── DOM refs ────────────────────────────────────────────────────── */
const canvas = document.getElementById('canvas');
const cameraMode = document.getElementById('camera-mode');
const channelMap = document.getElementById('channel-map');
const resetButton = document.getElementById('reset-button');
const gamepadStatus = document.getElementById('gamepad-status');
const telemetry = document.getElementById('telemetry');
const stickLeft = document.getElementById('stick-left');
const stickRight = document.getElementById('stick-right');
const crashBanner = document.getElementById('crash-banner');
const godModeCheckbox = document.getElementById('god-mode');
const readyOverlay = document.getElementById('ready-overlay');
const startButton = document.getElementById('start-button');
const armHint = document.getElementById('arm-hint');
const loadingText = document.getElementById('loading-text');
const calibrateButton = document.getElementById('calibrate-button');
const calibrationStatus = document.getElementById('calibration-status');
const calibrationOverlay = document.getElementById('calibration-overlay');
const calibInstruction = document.getElementById('calib-instruction');
const calibAxes = document.getElementById('calib-axes');
const calibStatus = document.getElementById('calib-status');
const calibNext = document.getElementById('calib-next');
const calibCancel = document.getElementById('calib-cancel');
const calibClear = document.getElementById('calib-clear');

/* ─── Three.js scene ──────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9CD6F2);
scene.fog = new THREE.Fog(0xBFD9E8, 50, 180);

// HDR sky: equirectangular texture used both as skybox and as IBL dome light.
new RGBELoader().load(hdrSkyUrl, (texture) => {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = texture;
  scene.environment = texture;
});

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);

// The HDR environment supplies most ambient light; the sun adds direction
// and casts shadows. Fixed offset from the drone, kept constant each frame
// (see updateSun below) so the shadow frustum travels with the world.
const SUN_OFFSET = new THREE.Vector3(30, 50, 20);
const sun = new THREE.DirectionalLight(0xFFFFFF, 1.8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SHADOW_HALF = 110;
sun.shadow.camera.left = -SHADOW_HALF;
sun.shadow.camera.right = SHADOW_HALF;
sun.shadow.camera.top = SHADOW_HALF;
sun.shadow.camera.bottom = -SHADOW_HALF;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 220;
sun.shadow.bias = -0.0015;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
scene.add(new THREE.AmbientLight(0xE8F2F8, 0.3));

/**
 * Keep the sun (and its shadow frustum) centered on a moving target, since
 * the shadow camera can't cover the infinite world at usable resolution.
 * @param {THREE.Vector3} target World point to center the shadow frustum on.
 */
function updateSun(target) {
  sun.position.copy(target).add(SUN_OFFSET);
  sun.target.position.copy(target);
  sun.target.updateMatrixWorld();
}

// Spawn resting on the ground so the drone doesn't free-fall on load.
const SPAWN = new THREE.Vector3(0, DRONE_RADIUS, 0);
const world = new World(scene);
world.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

// The city geometry loads asynchronously; gate takeoff until it's ready.
startButton.disabled = true;
loadBuildingPool()
  .then((pool) => {
    world.setPool(pool, SPAWN);
    loadingText.hidden = true;
    startButton.disabled = false;
  })
  .catch((err) => {
    console.error('Failed to load building pool:', err);
    loadingText.textContent = 'Failed to load city geometry — see console.';
  });

const drone = new Drone(SPAWN);
scene.add(drone.mesh);

const input = new InputManager((status) => {
  gamepadStatus.textContent = status;
});

/* ─── Calibration wizard ──────────────────────────────────────────── */
/** Sync the channel-map select and ready-screen status with input state. */
function syncCalibrationUi() {
  channelMap.value = input.channelMap;
  calibrationStatus.textContent = input.calibration
    ? 'Saved calibration found — Channel Map is set to Custom.'
    : 'No saved calibration — using the AETR default map.';
}

const wizard = new CalibrationWizard(
  input,
  {
    overlay: calibrationOverlay,
    instruction: calibInstruction,
    axesContainer: calibAxes,
    status: calibStatus,
    nextButton: calibNext,
  },
  syncCalibrationUi
);

/* ─── State ───────────────────────────────────────────────────────── */
/** @type {'ready' | 'flying' | 'crashed'} */
let flightState = 'ready';
let crashTimer = 0;

/* ─── Flight state transitions ────────────────────────────────────── */
/** Show the crash banner, then return to the ready screen. */
function crash() {
  flightState = 'crashed';
  crashTimer = 1.2;
  crashBanner.hidden = false;
}

/** Respawn the drone on the pad and show the ready screen. */
function resetDrone() {
  drone.reset();
  input.reset();
  flightState = 'ready';
  crashTimer = 0;
  crashBanner.hidden = true;
  armHint.hidden = true;
  readyOverlay.hidden = false;
}

/**
 * Arm and take control. Refuses to arm while the RC throttle stick is up,
 * so a plugged-in transmitter can't launch the drone unexpectedly.
 */
function startFlying() {
  if (flightState !== 'ready' || wizard.active || !world.ready) return;
  if (input.activeGamepad() && input.poll(0).throttle > 0.1) {
    armHint.hidden = false;
    return;
  }
  armHint.hidden = true;
  readyOverlay.hidden = true;
  flightState = 'flying';
}

/* ─── Camera ──────────────────────────────────────────────────────── */
const cameraTarget = new THREE.Vector3();

/** Position the camera for the selected mode. */
function updateCamera() {
  const mode = cameraMode.value;
  // Hide the airframe in FPV so the canopy doesn't block the view.
  drone.mesh.visible = mode !== 'fpv';
  if (mode === 'fpv') {
    camera.position.copy(drone.position);
    // Camera and drone both face their local -Z, so the orientations match 1:1.
    camera.quaternion.copy(drone.mesh.quaternion);
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
  cameraTarget.lerp(drone.position, 0.25);
  camera.lookAt(cameraTarget);
}

/* ─── Resize handler ──────────────────────────────────────────────── */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ─── Event listeners ─────────────────────────────────────────────── */
channelMap.addEventListener('change', (e) => {
  input.channelMap = e.target.value;
});

calibrateButton.addEventListener('click', () => wizard.start());
calibNext.addEventListener('click', () => wizard.next());
calibCancel.addEventListener('click', () => wizard.cancel());
calibClear.addEventListener('click', () => {
  input.clearCalibration();
  wizard.cancel();
});

resetButton.addEventListener('click', resetDrone);
startButton.addEventListener('click', startFlying);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetDrone();
  if (e.code === 'KeyC') {
    const modes = Array.from(cameraMode.options).map((o) => o.value);
    const next = (modes.indexOf(cameraMode.value) + 1) % modes.length;
    cameraMode.value = modes[next];
  }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    // Drop focus so Space doesn't also re-activate a focused button on keyup.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    startFlying();
  }
});

/* ─── HUD ─────────────────────────────────────────────────────────── */
/**
 * Move a stick indicator dot.
 * @param {HTMLElement} dot Indicator element.
 * @param {number} x Horizontal input in [-1, 1].
 * @param {number} y Vertical input in [-1, 1] (up = +1).
 */
function updateStick(dot, x, y) {
  dot.style.transform = `translate(calc(-50% + ${x * 24}px), calc(-50% + ${-y * 24}px))`;
}

/* ─── Main loop ───────────────────────────────────────────────────── */
syncCalibrationUi();

let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  // Clamp dt so a background tab doesn't produce one giant physics step.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  wizard.update(dt);

  if (flightState === 'crashed') {
    crashTimer -= dt;
    if (crashTimer <= 0) resetDrone();
  } else if (flightState === 'ready') {
    // Physics paused: just mirror stick input so the controller can be verified.
    const controls = input.poll(dt);
    updateStick(stickLeft, controls.yaw, controls.throttle * 2 - 1);
    updateStick(stickRight, controls.roll, controls.pitch);
  } else {
    const controls = input.poll(dt);
    drone.update(controls, dt);
    const godMode = godModeCheckbox.checked;

    // Ground contact: gentle touch lands, hard impact crashes (unless god mode).
    if (drone.position.y < DRONE_RADIUS) {
      if (drone.velocity.y < -4 && !godMode) {
        crash();
      } else {
        drone.position.y = DRONE_RADIUS;
        drone.velocity.y = Math.max(0, drone.velocity.y);
      }
    }

    if (!godMode && world.collides(drone.position, DRONE_RADIUS)) crash();

    updateStick(stickLeft, controls.yaw, controls.throttle * 2 - 1);
    updateStick(stickRight, controls.roll, controls.pitch);
    const distance = Math.hypot(drone.position.x, drone.position.z);
    telemetry.textContent =
      `ALT ${drone.position.y.toFixed(1)} m | SPD ${drone.speed().toFixed(1)} m/s | ` +
      `DST ${distance.toFixed(0)} m`;
  }

  world.update(drone.position);

  updateCamera();
  world.fadeNear(camera.position, cameraMode.value !== 'fpv');
  updateSun(drone.position);
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
