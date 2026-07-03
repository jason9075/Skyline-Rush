import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import './style.css';
import hdrSkyUrl from '../assets/kloofendal_48d_partly_cloudy_puresky_1k.hdr?url';
import { loadBuildingPool } from './buildings.js';
import { CameraRig } from './camera.js';
import { ControlsUI } from './controls-ui.js';
import { Drone, DRONE_RADIUS } from './drone.js';
import { GateCourse } from './gates.js';
import { Hud } from './hud.js';
import { InputManager } from './input.js';
import { SettingsStore } from './settings.js';
import { StrikeMission } from './strike.js';
import { TouchControls } from './touch.js';
import { World } from './world.js';

/* ─── DOM refs ────────────────────────────────────────────────────── */
const canvas = document.getElementById('canvas');
const settingsButton = document.getElementById('settings-button');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const flightMode = document.getElementById('flight-mode');
const gameMode = document.getElementById('game-mode');
const difficulty = document.getElementById('difficulty');
const difficultyLabel = document.getElementById('difficulty-label');
const gateHud = document.getElementById('gate-hud');
const gateArrow = document.getElementById('gate-arrow');
const gateInfo = document.getElementById('gate-info');
const gateTimer = document.getElementById('gate-timer');
const strikeHud = document.getElementById('strike-hud');
const strikeEnemies = document.getElementById('strike-enemies');
const strikeHp = document.getElementById('strike-hp');
const dropButton = document.getElementById('drop-button');
const dropCount = document.getElementById('drop-count');
const resultsOverlay = document.getElementById('results-overlay');
const resultsTitle = document.getElementById('results-title');
const resultsSub = document.getElementById('results-sub');
const resultsScore = document.getElementById('results-score');
const resultsLabel = document.getElementById('results-label');
const resultsAgain = document.getElementById('results-again');
const passFlash = document.getElementById('pass-flash');
const osd = document.getElementById('osd');
const osdCheckbox = document.getElementById('osd-toggle');
const osdHorizon = document.getElementById('osd-horizon');
const osdSpeedValue = document.getElementById('osd-speed-value');
const osdAltValue = document.getElementById('osd-alt-value');
const cameraMode = document.getElementById('camera-mode');
const cameraPitch = document.getElementById('camera-pitch');
const cameraPitchValue = document.getElementById('camera-pitch-value');
const resetButton = document.getElementById('reset-button');
const gamepadStatus = document.getElementById('gamepad-status');
const stickLeft = document.getElementById('stick-left');
const stickRight = document.getElementById('stick-right');
const crashBanner = document.getElementById('crash-banner');
const armBanner = document.getElementById('arm-banner');
const godModeCheckbox = document.getElementById('god-mode');
const readyOverlay = document.getElementById('ready-overlay');
const startButton = document.getElementById('start-button');
const loadingText = document.getElementById('loading-text');

/* ─── Three.js scene ──────────────────────────────────────────────── */
// Touch devices are treated as mobile: shadows are disabled and the pixel
// ratio is capped, since a phone GPU can't afford both the shadow pass and a
// 3× device-pixel-ratio framebuffer over the infinite city.
const isTouch = TouchControls.isSupported();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(isTouch ? Math.min(window.devicePixelRatio, 1.5) : window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = !isTouch;
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
sun.castShadow = !isTouch;
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

// On-screen dual joysticks for phones/tablets (Mode 2 layout). Only mounted on
// touch devices, where it becomes the input source ahead of the keyboard.
if (isTouch) {
  document.body.classList.add('touch');
  input.setTouchControls(new TouchControls());

  // Block pinch-zoom so two-thumb stick input never zooms the page. The pads
  // drive off Pointer Events, so cancelling multi-touch touchmove (and iOS's
  // gesture events, which ignore user-scalable=no) leaves the sticks working.
  document.addEventListener(
    'touchmove',
    (e) => { if (e.touches.length > 1) e.preventDefault(); },
    { passive: false }
  );
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault());
  }
}

/* ─── Subsystems ──────────────────────────────────────────────────── */
// controlsUi persists on change through settingsStore, which in turn reads
// controlsUi — so the save callback is a thunk resolved once both exist.
let settingsStore;
const controlsUi = new ControlsUI(input, isTouch, () => settingsStore.save());
const cameraRig = new CameraRig(camera, {
  modeSelect: cameraMode,
  pitchSlider: cameraPitch,
  pitchValue: cameraPitchValue,
});
const hud = new Hud({
  osd, osdHorizon, osdSpeedValue, osdAltValue,
  strikeHud, strikeEnemies, strikeHp, dropButton, dropCount,
  gateHud, gateArrow, gateInfo, gateTimer,
  stickLeft, stickRight,
});
settingsStore = new SettingsStore(
  { flightMode, gameMode, difficulty, cameraMode, cameraPitch, godModeCheckbox, osdCheckbox },
  controlsUi,
  drone,
);

/** OSD is an in-flight instrument: sync its visibility from the current state. */
function syncOsd() {
  hud.syncOsdVisibility(osdCheckbox.checked, flightState === 'flying');
}

/* ─── State ───────────────────────────────────────────────────────── */
/** @type {'ready' | 'flying' | 'crashed' | 'results'} */
let flightState = 'ready';
let crashTimer = 0;
const CRASH_DURATION = 1.2;
/** Gate Rush run length, seconds. */
const GATE_TIME_LIMIT = 180;
/** Seconds remaining in the current Gate Rush run; only counts down while flying. */
let gateTimeLeft = GATE_TIME_LIMIT;
/**
 * True while arming a checkpoint respawn, so {@link attemptAutoArm} keeps the
 * existing course (preserving score and clock) instead of building a new one.
 */
let resumeRun = false;
/** True while waiting to auto-rearm after a crash, without a manual Start press. */
let pendingAutoStart = false;
/**
 * Camera pose at the instant of an FPV crash, so the crash-cam transition
 * can pull back from it. Null when the crash happened in a non-FPV mode,
 * since the airframe is already visible there.
 * @type {{position: THREE.Vector3, quaternion: THREE.Quaternion} | null}
 */
let crashCamOrigin = null;
/** @type {GateCourse | null} */
let course = null;
/** @type {StrikeMission | null} */
let strike = null;

/**
 * Create or clear the active game-mode object to match the current mode and
 * flight state. Called on mode/difficulty changes and flight-state
 * transitions, so switching settings mid-flight restarts the mode from the
 * drone's current position.
 */
function rebuildMode() {
  if (course) { course.dispose(); course = null; }
  if (strike) { strike.dispose(); strike = null; }

  if (flightState === 'flying') {
    // Drone faces local -Z; its horizontal facing follows from yaw alone.
    const forward = new THREE.Vector3(-Math.sin(drone.yaw), 0, -Math.cos(drone.yaw));
    if (gameMode.value === 'gate') {
      course = new GateCourse(scene, difficulty.value, drone.position, forward);
      // A fresh course means a fresh run: restart the countdown. Checkpoint
      // respawns keep the same course object, so they never reach here.
      gateTimeLeft = GATE_TIME_LIMIT;
    } else if (gameMode.value === 'strike') {
      strike = new StrikeMission(scene, world, drone.position, forward);
    }
  }
  hud.showGate(Boolean(course));
  hud.showStrike(Boolean(strike));
  if (strike) hud.primeStrike(strike);
}

/** Difficulty only applies to Gate Rush; hide it in other modes. */
function syncGameModeUi() {
  const isGate = gameMode.value === 'gate';
  difficultyLabel.hidden = !isGate;
  difficulty.hidden = !isGate;
}

/* ─── Flight state transitions ────────────────────────────────────── */
/** Show the crash banner, then return to the ready screen. */
function crash() {
  // In Strike a city impact ends the mission and tallies the kills scored so
  // far, the same as being shot down — there is no checkpoint to resume from.
  if (strike) { finishStrike(); return; }
  flightState = 'crashed';
  crashTimer = CRASH_DURATION;
  syncOsd();
  crashBanner.textContent = course ? `CRASHED · ${course.score} GATES` : 'CRASHED';
  crashBanner.hidden = false;
  // In FPV the airframe is hidden, so pulling the camera back from the
  // point of impact is the only way to see which part hit.
  crashCamOrigin =
    cameraMode.value === 'fpv'
      ? { position: camera.position.clone(), quaternion: camera.quaternion.clone() }
      : null;
}

/**
 * Respawn the drone on the pad.
 * @param {boolean} autoStart After a crash, skip the manual Start screen and
 *   rearm as soon as the throttle stick is confirmed down (see
 *   {@link attemptAutoArm}), instead of waiting for Space/Enter/click.
 */
function resetDrone(autoStart = false) {
  drone.reset();
  input.reset();
  resumeRun = false;
  flightState = 'ready';
  crashTimer = 0;
  crashCamOrigin = null;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = autoStart;
  readyOverlay.hidden = autoStart;
  rebuildMode();
  syncOsd();
}

/**
 * Dismiss the ready screen and queue arming. The actual throttle-down safety
 * check lives in {@link attemptAutoArm}, which runs every frame — so Start
 * always closes the overlay, and flight begins once the stick is confirmed low.
 */
function startFlying() {
  if (flightState !== 'ready' || controlsUi.isBusy() || !world.ready) return;
  readyOverlay.hidden = true;
  resumeRun = false;
  pendingAutoStart = true;
}

/**
 * Retry arming every frame while {@link pendingAutoStart} is set (after
 * Start or a post-crash respawn). Refuses to arm while the RC throttle
 * stick is up — so a plugged-in transmitter can't launch the drone
 * unexpectedly — showing a reminder banner until the stick is lowered.
 */
function attemptAutoArm() {
  if (!pendingAutoStart || flightState !== 'ready' || controlsUi.isBusy() || !world.ready) return;
  if ((input.hasBindings() || input.activeGamepad() || input.touchActive()) && input.poll(0).throttle > 0.1) {
    armBanner.hidden = false;
    return;
  }
  pendingAutoStart = false;
  armBanner.hidden = true;
  flightState = 'flying';
  // A checkpoint resume keeps the live course (and its score/clock); only a
  // fresh Start or full reset builds a new one.
  if (resumeRun) resumeRun = false;
  else rebuildMode();
  syncOsd();
}

/**
 * Resume a Gate Rush run from the last cleared checkpoint after a crash: the
 * course, score, and countdown are all preserved, so only the drone is reset —
 * to the checkpoint pose, then re-armed via the usual throttle-down check.
 * Falls back to a full origin reset when there's no active course.
 */
function respawnAtCheckpoint() {
  if (!course) {
    resetDrone(true);
    return;
  }
  const { pos, forward } = course.checkpoint;
  // Set down on the ground beneath the checkpoint gate (roads are building-free
  // corridors, so the spot is clear): respawning at the gate's altitude would
  // just free-fall and crash again the moment the drone re-arms.
  const ground = new THREE.Vector3(pos.x, DRONE_RADIUS, pos.z);
  // Drone faces local -Z, so recover yaw from the checkpoint forward vector.
  drone.respawn(ground, Math.atan2(-forward.x, -forward.z));
  course.resumeFrom(ground);
  resumeRun = true;
  input.reset();
  flightState = 'ready';
  crashTimer = 0;
  crashCamOrigin = null;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = true;
  readyOverlay.hidden = true;
  syncOsd();
}

/** End the Gate Rush run when the clock expires and show the results screen. */
function finishRun() {
  flightState = 'results';
  resultsTitle.textContent = 'Time!';
  resultsSub.textContent = 'Gate Rush — 3 minute run';
  resultsScore.textContent = String(course ? course.score : 0);
  resultsLabel.textContent = 'Gates Cleared';
  resultsOverlay.hidden = false;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = false;
  syncOsd();
}

/**
 * End a Strike mission and show the results screen. The kill tally is the
 * score whether the drone cleared the force (win), was shot down, or crashed.
 */
function finishStrike() {
  flightState = 'results';
  const won = strike && strike.status === 'won';
  resultsTitle.textContent = won ? 'Cleared!' : 'Mission Ended';
  resultsSub.textContent = won ? 'All hostiles destroyed' : 'Drone down';
  resultsScore.textContent = String(strike ? strike.killed : 0);
  resultsLabel.textContent = 'Enemies Destroyed';
  resultsOverlay.hidden = false;
  hud.showStrike(false);
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = false;
  syncOsd();
}

/**
 * Drop a bomb from the current drone pose (Strike mode, in flight). The bomb
 * inherits the drone's velocity; stock is spent inside the mission.
 */
function dropBomb() {
  if (!strike || flightState !== 'flying') return;
  strike.dropBomb(drone.position, drone.velocity);
  hud.updateStrike(strike);
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
// Every settings control lives inside the modal, so one bubbled 'change'
// listener persists them all.
settingsModal.addEventListener('change', () => settingsStore.save());
settingsButton.addEventListener('click', () => { settingsModal.hidden = false; });
settingsClose.addEventListener('click', () => { settingsModal.hidden = true; });
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true;
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !settingsModal.hidden) settingsModal.hidden = true;
});

flightMode.addEventListener('change', (e) => {
  drone.flightMode = e.target.value;
  input.flightMode = e.target.value;
});

osdCheckbox.addEventListener('change', syncOsd);

gameMode.addEventListener('change', () => {
  syncGameModeUi();
  rebuildMode();
});
difficulty.addEventListener('change', rebuildMode);

resetButton.addEventListener('click', () => resetDrone());
startButton.addEventListener('click', startFlying);
resultsAgain.addEventListener('click', () => {
  resultsOverlay.hidden = true;
  resetDrone();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetDrone();
  if (e.code === 'KeyC') {
    const modes = Array.from(cameraMode.options).map((o) => o.value);
    const next = (modes.indexOf(cameraMode.value) + 1) % modes.length;
    cameraMode.value = modes[next];
    settingsStore.save();
  }
  if (e.code === 'KeyG') {
    godModeCheckbox.checked = !godModeCheckbox.checked;
    settingsStore.save();
  }
  if (e.code === 'KeyO') {
    osdCheckbox.checked = !osdCheckbox.checked;
    syncOsd();
    settingsStore.save();
  }
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    // Drop focus so Space doesn't also re-activate a focused button on keyup.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // While striking, Space is the bomb release; on the ready screen it still
    // arms. Enter always arms (its wording is "Start"), never drops.
    if (e.code === 'Space' && flightState === 'flying' && strike) dropBomb();
    else startFlying();
  }
});

// pointerdown, not click: while a finger holds the left stick, mobile browsers
// suppress the synthetic click on a second-finger tap, so the bomb button felt
// dead during flight. Pointer events fire per-pointer, independent of the
// stick's captured pointer, so a two-thumb tap registers.
dropButton.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dropButton.blur();
  dropBomb();
});

/* ─── Main loop ───────────────────────────────────────────────────── */
settingsStore.load();
// settingsStore.load() restored drone.flightMode; mirror it onto the input so
// the touch branch shapes the sticks for the right mode from the first frame.
input.flightMode = drone.flightMode;
controlsUi.init();
syncGameModeUi();
// Re-sync the FPV tilt after load, since it may have restored a new pitch value.
cameraRig.syncPitch();
syncOsd();

let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  // Clamp dt so a background tab doesn't produce one giant physics step.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  controlsUi.update(dt);

  if (flightState === 'crashed') {
    crashTimer -= dt;
    // In Gate Rush, resume from the last checkpoint (keeping score and clock);
    // respawnAtCheckpoint falls back to a full reset when there's no course.
    if (crashTimer <= 0) respawnAtCheckpoint();
  } else if (flightState === 'results') {
    // Frozen scene behind the results overlay; wait for Play Again.
  } else if (flightState === 'ready') {
    // Physics paused: just mirror stick input so the controller can be verified.
    // previewControls() is a hook for showing an in-progress config on the ready
    // sticks; it currently returns null (the binding grid has its own bars), so
    // this reads the live poll.
    const controls = controlsUi.previewControls() ?? input.poll(dt);
    hud.updateSticks(controls);
    attemptAutoArm();
  } else {
    const controls = input.poll(dt);
    drone.update(controls, dt);
    const godMode = godModeCheckbox.checked;

    // Ground contact: gentle touch lands, hard impact crashes (unless god mode).
    if (drone.position.y < DRONE_RADIUS) {
      if (drone.velocity.y < -6 && !godMode) {
        crash();
      } else {
        drone.position.y = DRONE_RADIUS;
        drone.velocity.y = Math.max(0, drone.velocity.y);
      }
    }

    if (!godMode && world.collides(drone.position, DRONE_RADIUS)) crash();

    if (course && flightState === 'flying') {
      // The clock starts only after the first gate is cleared.
      if (course.score >= 1) gateTimeLeft -= dt;
      if (gateTimeLeft <= 0) {
        gateTimeLeft = 0;
        finishRun();
      } else {
        const gateEvent = course.update(drone.position, dt);
        if (gateEvent) {
          // Restart the CSS animation even if the previous flash is mid-run.
          passFlash.className = '';
          void passFlash.offsetWidth;
          passFlash.classList.add(gateEvent);
        }
        hud.updateGate(course, drone, camera, gateTimeLeft);
      }
    }

    if (strike && flightState === 'flying') {
      const { damage } = strike.update(drone.position, dt, godMode);
      if (damage > 0) hud.flashStrikeHit();
      hud.updateStrike(strike);
      if (strike.status !== 'active') finishStrike();
    }

    if (hud.osdVisible) hud.updateOsd(drone, camera);

    hud.updateSticks(controls);
  }

  world.update(drone.position);

  cameraRig.update(drone, {
    flightState,
    crashTimer,
    crashDuration: CRASH_DURATION,
    crashCamOrigin,
  });
  world.fadeNear(camera.position, cameraMode.value !== 'fpv');
  updateSun(drone.position);
  renderer.render(scene, camera);
}

requestAnimationFrame(animate);
