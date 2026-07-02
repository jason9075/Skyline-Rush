import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import hdrSkyUrl from '../assets/kloofendal_48d_partly_cloudy_puresky_1k.hdr?url';
import { loadBuildingPool } from './buildings.js';
import { CalibrationWizard } from './calibration.js';
import { Drone, DRONE_RADIUS } from './drone.js';
import { GateCourse } from './gates.js';
import { expoCurve, InputManager } from './input.js';
import { TouchControls } from './touch.js';
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
    display: flex; gap: 0.5rem; align-items: center;
    padding: 0.4rem; z-index: 47; font-size: 0.85rem;
  }
  #toolbar button {
    font: inherit; border: 1px solid var(--me-gray); border-radius: 2px;
    background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(10px);
    color: var(--me-dark); cursor: pointer;
    width: 2.4rem; height: 2.4rem; display: grid; place-items: center;
  }
  #toolbar button:hover { background: var(--me-red); border-color: var(--me-red); color: #fff; }
  #toolbar .icon-button { font-size: 1.2rem; }
  .toggle-label {
    display: flex; align-items: center; gap: 0.35rem; cursor: pointer;
    color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em;
  }
  .toggle-label input { accent-color: var(--me-red); cursor: pointer; }
  #settings-modal[hidden] { display: none; }
  #settings-modal {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(27, 30, 32, 0.35); backdrop-filter: blur(4px); z-index: 48;
  }
  #settings-modal .modal-panel {
    width: min(360px, calc(100vw - 2rem)); padding: 1.5rem;
    background: var(--me-panel); border: 1px solid var(--me-gray); border-radius: 2px;
    border-top: 4px solid var(--me-red);
    box-shadow: 0 20px 60px rgba(27, 30, 32, 0.25);
    display: grid; gap: 1rem;
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    gap: 1rem;
  }
  .modal-header h2 {
    font-size: 1rem; color: var(--me-dark);
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .modal-toggle {
    font: inherit; font-size: 0.8rem; cursor: pointer;
    border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-panel); color: var(--me-dark);
    padding: 0.35rem 0.7rem;
  }
  .modal-toggle:hover { border-color: var(--me-red); color: var(--me-red); }
  .modal-body { display: grid; gap: 0.4rem; }
  .modal-body label {
    font: inherit; color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em; margin-top: 0.5rem;
  }
  .modal-body label:first-child { margin-top: 0; }
  .modal-body select {
    font: inherit; border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-light); color: var(--me-dark);
    padding: 0.5rem 0.6rem; cursor: pointer;
  }
  .modal-body input[type="range"] { accent-color: var(--me-red); cursor: pointer; }
  #camera-pitch-value { color: var(--me-dark); font-family: monospace; }
  .modal-body .toggle-label { margin-top: 0.4rem; }
  /* Above the ready/calibration overlays (40/45) so the sticks stay visible
     for verifying the RC controller before starting. */
  #hud {
    position: fixed; bottom: 1rem; left: 1rem; z-index: 46;
    display: grid; gap: 0.5rem; font-size: 0.8rem;
  }
  #gamepad-status { color: var(--me-red); font-weight: 700; }
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
  #gate-hud {
    position: fixed; top: 1rem; left: 50%; transform: translateX(-50%);
    display: flex; gap: 0.6rem; align-items: center; z-index: 46;
    color: var(--me-red); font-weight: 800; font-size: 1rem;
    letter-spacing: 0.05em; font-family: monospace;
  }
  #gate-hud[hidden] { display: none; }
  #gate-arrow { display: inline-block; font-size: 1.3rem; }
  /* FPV-goggle style OSD: white monospace glyphs with a soft dark halo so
     they read over both the bright sky and white facades. Sits below the
     gate flash (28) and above the scene; never intercepts the pointer. */
  #osd {
    position: fixed; inset: 0; pointer-events: none; z-index: 27;
    font-family: 'JetBrains Mono', 'Consolas', monospace;
    color: rgba(255, 255, 255, 0.92);
    text-shadow: 0 0 4px rgba(27, 30, 32, 0.6), 0 1px 2px rgba(27, 30, 32, 0.7);
  }
  #osd[hidden] { display: none; }
  /* Artificial horizon: a short line with a clear center gap, rotated by
     roll and shifted by pitch from JS. Stacked drop-shadows give it a dark
     halo so it stays visible against the white ground and facades. */
  #osd-horizon {
    position: absolute; left: 50%; top: 50%;
    width: 16vw; height: 2px; will-change: transform;
    background: linear-gradient(to right,
      currentColor 0 35%, transparent 35% 65%, currentColor 65% 100%);
    opacity: 0.9;
    filter: drop-shadow(0 0 2px rgba(27, 30, 32, 0.95))
            drop-shadow(0 1px 3px rgba(27, 30, 32, 0.7));
  }
  /* Fixed screen-center crosshair (does not rotate with roll): the aircraft
     reference point the horizon line is read against. */
  #osd-crosshair {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 16px; height: 16px;
    filter: drop-shadow(0 0 2px rgba(27, 30, 32, 0.95))
            drop-shadow(0 1px 3px rgba(27, 30, 32, 0.7));
  }
  #osd-crosshair::before, #osd-crosshair::after {
    content: ''; position: absolute; background: currentColor;
  }
  #osd-crosshair::before {
    left: 50%; top: 0; width: 2px; height: 100%; transform: translateX(-50%);
  }
  #osd-crosshair::after {
    top: 50%; left: 0; width: 100%; height: 2px; transform: translateY(-50%);
  }
  #osd-info {
    position: absolute; right: 1.2rem; bottom: 1rem;
    display: flex; gap: 1.4rem;
  }
  .osd-readout { display: grid; justify-items: center; gap: 0.1rem; }
  .osd-label { font-size: 0.65rem; letter-spacing: 0.25em; opacity: 0.7; }
  .osd-value { font-size: 1.5rem; font-weight: 700; }
  .osd-unit { font-size: 0.65rem; opacity: 0.7; }
  /* Edge vignette pulse on gate events: the screen center stays clear so it
     never blocks the FPV view. White = pass, red = miss. */
  #pass-flash {
    position: fixed; inset: 0; pointer-events: none; z-index: 28; opacity: 0;
  }
  #pass-flash.pass, #pass-flash.miss {
    animation: gate-flash 0.45s ease-out;
  }
  #pass-flash.pass { --flash-color: rgba(255, 255, 255, 0.6); }
  #pass-flash.miss { --flash-color: rgba(224, 48, 30, 0.55); }
  #pass-flash.pass, #pass-flash.miss {
    background: radial-gradient(ellipse at center, transparent 55%, var(--flash-color) 100%);
  }
  @keyframes gate-flash {
    0% { opacity: 0; }
    25% { opacity: 1; }
    100% { opacity: 0; }
  }
  #crash-banner {
    position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%);
    color: var(--me-red); font-size: 2.4rem; font-weight: 800;
    letter-spacing: 0.12em; text-transform: uppercase; z-index: 30;
  }
  #crash-banner[hidden] { display: none; }
  /* Reminder shown while auto-rearming after a crash: the drone won't take
     off until the throttle stick is confirmed down, but no Start click is
     required once it is. */
  #arm-banner {
    position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%);
    color: var(--me-orange); font-size: 1.3rem; font-weight: 800;
    letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
    z-index: 30;
  }
  #arm-banner[hidden] { display: none; }
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
  .ready-device-label {
    color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em;
  }
  .ready-panel select {
    font: inherit; justify-self: center; width: min(320px, 100%);
    border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-light); color: var(--me-dark);
    padding: 0.5rem 0.6rem; cursor: pointer;
  }
  .ready-panel ul {
    list-style: none; text-align: left; display: grid; gap: 0.4rem;
    color: var(--me-mid); font-size: 0.85rem; line-height: 1.5;
  }
  .ready-panel ul li::before { content: '›'; color: var(--me-red); margin-right: 0.5rem; }
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
  #rates-overlay {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(250, 251, 252, 0.65); backdrop-filter: blur(4px); z-index: 45;
  }
  #rates-overlay[hidden] { display: none; }
  .rates-hint { color: var(--me-mid); font-size: 0.8rem; }
  #expo-curve {
    justify-self: center; width: 320px; max-width: 100%;
    border: 1px solid var(--me-gray); border-radius: 2px;
    background: var(--me-light);
  }
  .rate-row {
    display: grid; grid-template-columns: 8.5rem 1fr 3rem;
    align-items: center; gap: 0.6rem; text-align: left;
  }
  .rate-row label {
    color: var(--me-mid); text-transform: uppercase;
    font-size: 0.7rem; letter-spacing: 0.05em;
  }
  .rate-row input[type="range"] { accent-color: var(--me-red); cursor: pointer; }
  .rate-value { font-family: monospace; font-size: 0.85rem; text-align: right; }
  #rates-done {
    justify-self: center; font: inherit; font-size: 0.9rem; cursor: pointer;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 0.55rem 1.8rem; border-radius: 2px;
    border: 1px solid var(--me-red); background: var(--me-red); color: #fff;
  }
  #rates-done:hover { background: var(--me-red-dark); }
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
  /* Touch devices drive the on-screen pads, so the desktop stick HUD and
     keyboard hints are redundant — hide them to keep the view clear. */
  body.touch #hud, body.touch #info { display: none; }
  /* Kill double-tap-to-zoom and the tap delay; single-finger scrolling (a tall
     settings modal) still works. Pinch is blocked by the viewport meta and the
     gesture handlers in the isTouch block. */
  body.touch { touch-action: manipulation; }
  /* Move the SPD/ALT readout to the top-left on touch: its default bottom-right
     spot sits under the right joystick pad. */
  body.touch #osd-info {
    right: auto; bottom: auto; left: 1rem; top: 1rem;
    flex-direction: column; align-items: flex-start; gap: 0.5rem;
  }
  /* The Space/Enter footnote is keyboard-specific; hide it on touch. The
     calibrate button and calibration-status footnote are toggled per input
     source in updateTutorial(). */
  body.touch .ready-footnote { display: none; }
`;
document.head.appendChild(style);

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
const passFlash = document.getElementById('pass-flash');
const osd = document.getElementById('osd');
const osdCheckbox = document.getElementById('osd-toggle');
const osdHorizon = document.getElementById('osd-horizon');
const osdSpeedValue = document.getElementById('osd-speed-value');
const osdAltValue = document.getElementById('osd-alt-value');
const cameraMode = document.getElementById('camera-mode');
const cameraPitch = document.getElementById('camera-pitch');
const cameraPitchValue = document.getElementById('camera-pitch-value');
const inputDevice = document.getElementById('input-device');
const channelMap = document.getElementById('channel-map');
const resetButton = document.getElementById('reset-button');
const gamepadStatus = document.getElementById('gamepad-status');
const stickLeft = document.getElementById('stick-left');
const stickRight = document.getElementById('stick-right');
const crashBanner = document.getElementById('crash-banner');
const armBanner = document.getElementById('arm-banner');
const godModeCheckbox = document.getElementById('god-mode');
const readyOverlay = document.getElementById('ready-overlay');
const readyTutorial = document.getElementById('ready-tutorial');
const startButton = document.getElementById('start-button');
const loadingText = document.getElementById('loading-text');
const calibrateButton = document.getElementById('calibrate-button');
const ratesButton = document.getElementById('rates-button');
const ratesOverlay = document.getElementById('rates-overlay');
const ratesDone = document.getElementById('rates-done');
const expoSlider = document.getElementById('expo-slider');
const expoValue = document.getElementById('expo-value');
const yawExpoSlider = document.getElementById('yaw-expo-slider');
const yawExpoValue = document.getElementById('yaw-expo-value');
const expoCanvas = document.getElementById('expo-curve');
const calibrationStatus = document.getElementById('calibration-status');
const calibrationOverlay = document.getElementById('calibration-overlay');
const calibInstruction = document.getElementById('calib-instruction');
const calibAxes = document.getElementById('calib-axes');
const calibStatus = document.getElementById('calib-status');
const calibNext = document.getElementById('calib-next');
const calibCancel = document.getElementById('calib-cancel');
const calibClear = document.getElementById('calib-clear');

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

/* ─── Input device selector ───────────────────────────────────────── */
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

/**
 * Effective input source given the selector value and connected hardware.
 * On touch devices the on-screen pads are always the working source.
 * @returns {'touch' | 'gamepad' | 'keyboard'}
 */
function effectiveSource() {
  const v = inputDevice.value;
  if (v !== 'keyboard' && (v !== 'auto' || input.listGamepads().length > 0)) return 'gamepad';
  return isTouch ? 'touch' : 'keyboard';
}

/** Rebuild the ready-screen tutorial and calibration UI for the current source. */
function updateTutorial() {
  const source = effectiveSource();
  readyTutorial.innerHTML = '';
  for (const text of TUTORIALS[source]) {
    const li = document.createElement('li');
    li.textContent = text;
    readyTutorial.appendChild(li);
  }
  // Calibration only applies to a physical gamepad.
  calibrateButton.hidden = source !== 'gamepad';
  calibrationStatus.hidden = source !== 'gamepad';
}

/** Push the selected device value into the input manager and refresh the UI. */
function syncInputDevice() {
  const v = inputDevice.value;
  input.selectInput(v === 'auto' || v === 'keyboard' ? v : Number(v));
  updateTutorial();
}

/**
 * Rebuild the device dropdown from the connected gamepads, preserving the
 * current choice when it's still available (otherwise falling back to Auto).
 * The two static options (Auto / Keyboard) are kept; only the dynamic
 * per-gamepad entries are refreshed.
 */
function populateInputDevices() {
  const prev = inputDevice.value;
  inputDevice.querySelectorAll('option[data-pad]').forEach((o) => o.remove());
  for (const { index, id } of input.listGamepads()) {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.dataset.pad = '1';
    opt.textContent = `${index}: ${id}`;
    inputDevice.appendChild(opt);
  }
  inputDevice.value = Array.from(inputDevice.options).some((o) => o.value === prev) ? prev : 'auto';
  syncInputDevice();
}

input.onDevicesChange = populateInputDevices;
inputDevice.addEventListener('change', syncInputDevice);

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
const CRASH_DURATION = 1.2;
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

/**
 * Create or clear the gate course to match the current game mode and flight
 * state. Called on mode/difficulty changes and flight-state transitions, so
 * switching settings mid-flight restarts the course from the drone's position.
 */
function rebuildCourse() {
  if (course) {
    course.dispose();
    course = null;
  }
  if (gameMode.value === 'gate' && flightState === 'flying') {
    // Drone faces local -Z; its horizontal facing follows from yaw alone.
    const forward = new THREE.Vector3(-Math.sin(drone.yaw), 0, -Math.cos(drone.yaw));
    course = new GateCourse(scene, difficulty.value, drone.position, forward);
  }
  gateHud.hidden = !course;
}

/** Difficulty only applies to Gate Rush; hide it in other modes. */
function syncGameModeUi() {
  const isGate = gameMode.value === 'gate';
  difficultyLabel.hidden = !isGate;
  difficulty.hidden = !isGate;
}

/* ─── OSD ─────────────────────────────────────────────────────────── */
/** OSD is an in-flight instrument: visible only when enabled AND flying. */
function syncOsdVisibility() {
  osd.hidden = !osdCheckbox.checked || flightState !== 'flying';
}

/** Refresh the OSD horizon and readouts from the drone state, once per frame. */
function updateOsd() {
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

/* ─── Flight state transitions ────────────────────────────────────── */
/** Show the crash banner, then return to the ready screen. */
function crash() {
  flightState = 'crashed';
  crashTimer = CRASH_DURATION;
  syncOsdVisibility();
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
  flightState = 'ready';
  crashTimer = 0;
  crashCamOrigin = null;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = autoStart;
  readyOverlay.hidden = autoStart;
  rebuildCourse();
  syncOsdVisibility();
}

/**
 * Dismiss the ready screen and queue arming. The actual throttle-down safety
 * check lives in {@link attemptAutoArm}, which runs every frame — so Start
 * always closes the overlay, and flight begins once the stick is confirmed low.
 */
function startFlying() {
  if (flightState !== 'ready' || wizard.active || !world.ready) return;
  readyOverlay.hidden = true;
  pendingAutoStart = true;
}

/**
 * Retry arming every frame while {@link pendingAutoStart} is set (after
 * Start or a post-crash respawn). Refuses to arm while the RC throttle
 * stick is up — so a plugged-in transmitter can't launch the drone
 * unexpectedly — showing a reminder banner until the stick is lowered.
 */
function attemptAutoArm() {
  if (!pendingAutoStart || flightState !== 'ready' || wizard.active || !world.ready) return;
  if ((input.activeGamepad() || input.touchActive()) && input.poll(0).throttle > 0.1) {
    armBanner.hidden = false;
    return;
  }
  pendingAutoStart = false;
  armBanner.hidden = true;
  flightState = 'flying';
  rebuildCourse();
  syncOsdVisibility();
}

/* ─── Camera ──────────────────────────────────────────────────────── */
const cameraTarget = new THREE.Vector3();

// FPV camera uptilt, like the fixed camera angle on a real FPV quad.
// Precomputed as a quaternion so the frame loop just multiplies.
const fpvTilt = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Refresh the FPV tilt quaternion and its label from the settings slider. */
function syncCameraPitch() {
  const deg = Number(cameraPitch.value);
  cameraPitchValue.textContent = `${deg}°`;
  fpvTilt.setFromAxisAngle(X_AXIS, THREE.MathUtils.degToRad(deg));
}
cameraPitch.addEventListener('input', syncCameraPitch);
syncCameraPitch();

const CRASH_CAM_PULLBACK = new THREE.Vector3(0, 1.5, 4);
const crashCamTargetPos = new THREE.Vector3();
const crashCamMatrix = new THREE.Matrix4();
const crashCamQuat = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Position the camera for the selected mode. */
function updateCamera() {
  const mode = cameraMode.value;

  if (flightState === 'crashed' && crashCamOrigin) {
    // Dolly back from the frozen FPV impact pose over the crash duration,
    // revealing the drone (and whatever it hit) instead of a static wall
    // of building texture filling the screen.
    const t = 1 - Math.max(0, crashTimer) / CRASH_DURATION;
    const ease = t * t * (3 - 2 * t);
    drone.mesh.visible = true;
    crashCamTargetPos
      .copy(CRASH_CAM_PULLBACK)
      .applyQuaternion(crashCamOrigin.quaternion)
      .add(crashCamOrigin.position);
    camera.position.lerpVectors(crashCamOrigin.position, crashCamTargetPos, ease);
    crashCamMatrix.lookAt(camera.position, drone.position, WORLD_UP);
    crashCamQuat.setFromRotationMatrix(crashCamMatrix);
    camera.quaternion.copy(crashCamOrigin.quaternion).slerp(crashCamQuat, ease);
    return;
  }

  // Hide the airframe in FPV so the canopy doesn't block the view.
  drone.mesh.visible = mode !== 'fpv';
  if (mode === 'fpv') {
    camera.position.copy(drone.position);
    // Camera and drone both face their local -Z, so the orientations match
    // 1:1; the configured uptilt is then applied in the drone's local frame.
    camera.quaternion.copy(drone.mesh.quaternion).multiply(fpvTilt);
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

/* ─── Rates & Expo ────────────────────────────────────────────────── */
/** Redraw the expo-curve preview: linear reference plus both active curves. */
function drawExpoCurve() {
  const ctx = expoCanvas.getContext('2d');
  const w = expoCanvas.width;
  const h = expoCanvas.height;
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
  plot(input.rates.yawExpo, '#4FA3D9');
  plot(input.rates.expo, '#E0301E');

  // Legend.
  ctx.font = '11px monospace';
  ctx.fillStyle = '#E0301E';
  ctx.fillText('PITCH/ROLL', pad + 2, pad + 10);
  ctx.fillStyle = '#4FA3D9';
  ctx.fillText('YAW', pad + 2, pad + 24);
}

/** Push the slider values into the input rates, labels, and curve preview. */
function syncRates() {
  input.rates.expo = Number(expoSlider.value) / 100;
  input.rates.yawExpo = Number(yawExpoSlider.value) / 100;
  expoValue.textContent = `${expoSlider.value}%`;
  yawExpoValue.textContent = `${yawExpoSlider.value}%`;
  drawExpoCurve();
}

/* ─── Settings persistence ────────────────────────────────────────── */
const SETTINGS_KEY = 'drone-control.settings';

/** Snapshot every settings control into localStorage. */
function saveSettings() {
  const settings = {
    flightMode: flightMode.value,
    gameMode: gameMode.value,
    difficulty: difficulty.value,
    cameraMode: cameraMode.value,
    cameraPitch: cameraPitch.value,
    inputDevice: inputDevice.value,
    channelMap: channelMap.value,
    godMode: godModeCheckbox.checked,
    osd: osdCheckbox.checked,
    expo: expoSlider.value,
    yawExpo: yawExpoSlider.value,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to persist settings:', err);
  }
}

/** Set a select's value only if that option actually exists. */
function setSelect(select, value) {
  if (Array.from(select.options).some((o) => o.value === value)) select.value = value;
}

/**
 * Restore saved settings into the controls and push them into the systems
 * that consume them (drone, input, camera). Dependent UI is synced by the
 * caller via the usual sync* helpers.
 */
function loadSettings() {
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
  // Only 'auto'/'keyboard' are stable across sessions; a saved gamepad index
  // has no matching option yet at load, so setSelect harmlessly ignores it
  // and populateInputDevices() re-applies it if the pad is still present.
  if (typeof s.inputDevice === 'string') setSelect(inputDevice, s.inputDevice);
  // Only restore CUSTOM if a calibration actually exists this session.
  if (typeof s.channelMap === 'string' && (s.channelMap !== 'CUSTOM' || input.calibration)) {
    setSelect(channelMap, s.channelMap);
  }
  if (typeof s.godMode === 'boolean') godModeCheckbox.checked = s.godMode;
  if (typeof s.osd === 'boolean') osdCheckbox.checked = s.osd;
  if (s.expo !== undefined && Number.isFinite(Number(s.expo))) {
    expoSlider.value = String(s.expo);
  }
  if (s.yawExpo !== undefined && Number.isFinite(Number(s.yawExpo))) {
    yawExpoSlider.value = String(s.yawExpo);
  }

  drone.flightMode = flightMode.value;
  input.channelMap = channelMap.value;
}

/* ─── Event listeners ─────────────────────────────────────────────── */
// Every settings control lives inside the modal, so one bubbled 'change'
// listener persists them all.
settingsModal.addEventListener('change', saveSettings);
settingsButton.addEventListener('click', () => { settingsModal.hidden = false; });
settingsClose.addEventListener('click', () => { settingsModal.hidden = true; });
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.hidden = true;
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !settingsModal.hidden) settingsModal.hidden = true;
  if (e.code === 'Escape' && !ratesOverlay.hidden) ratesOverlay.hidden = true;
});

channelMap.addEventListener('change', (e) => {
  input.channelMap = e.target.value;
});

flightMode.addEventListener('change', (e) => {
  drone.flightMode = e.target.value;
});

osdCheckbox.addEventListener('change', syncOsdVisibility);

gameMode.addEventListener('change', () => {
  syncGameModeUi();
  rebuildCourse();
});
difficulty.addEventListener('change', rebuildCourse);

ratesButton.addEventListener('click', () => {
  drawExpoCurve();
  ratesOverlay.hidden = false;
});
ratesDone.addEventListener('click', () => { ratesOverlay.hidden = true; });
expoSlider.addEventListener('input', syncRates);
yawExpoSlider.addEventListener('input', syncRates);
// Persist on release rather than every drag tick.
ratesOverlay.addEventListener('change', saveSettings);

calibrateButton.addEventListener('click', () => wizard.start());
calibNext.addEventListener('click', () => wizard.next());
calibCancel.addEventListener('click', () => wizard.cancel());
calibClear.addEventListener('click', () => {
  input.clearCalibration();
  wizard.cancel();
});

resetButton.addEventListener('click', () => resetDrone());
startButton.addEventListener('click', startFlying);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetDrone();
  if (e.code === 'KeyC') {
    const modes = Array.from(cameraMode.options).map((o) => o.value);
    const next = (modes.indexOf(cameraMode.value) + 1) % modes.length;
    cameraMode.value = modes[next];
    saveSettings();
  }
  if (e.code === 'KeyG') {
    godModeCheckbox.checked = !godModeCheckbox.checked;
    saveSettings();
  }
  if (e.code === 'KeyO') {
    osdCheckbox.checked = !osdCheckbox.checked;
    syncOsdVisibility();
    saveSettings();
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
loadSettings();
populateInputDevices();
syncCalibrationUi();
syncGameModeUi();
syncCameraPitch();
syncOsdVisibility();
syncRates();

const camDirTmp = new THREE.Vector3();

/** Refresh the gate HUD: score, distance, and bearing arrow. */
function updateGateHud() {
  const target = course.target;
  camera.getWorldDirection(camDirTmp);
  const dx = target.x - camera.position.x;
  const dz = target.z - camera.position.z;
  // Signed angle from camera forward to the gate (clockwise positive),
  // so the arrow points where the player must turn.
  const rel = Math.atan2(camDirTmp.x * dz - camDirTmp.z * dx, camDirTmp.x * dx + camDirTmp.z * dz);
  // The ➤ glyph points right, so offset by -90° to make it point up (toward
  // the gate) when it lies straight ahead.
  gateArrow.style.transform = `rotate(${(((rel * 180) / Math.PI) - 90).toFixed(1)}deg)`;
  gateInfo.textContent = `GATES ${course.score} | ${target.distanceTo(drone.position).toFixed(0)} m`;
}

let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  // Clamp dt so a background tab doesn't produce one giant physics step.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  wizard.update(dt);

  if (flightState === 'crashed') {
    crashTimer -= dt;
    if (crashTimer <= 0) resetDrone(true);
  } else if (flightState === 'ready') {
    // Physics paused: just mirror stick input so the controller can be verified.
    const controls = input.poll(dt);
    updateStick(stickLeft, controls.yaw, controls.throttle * 2 - 1);
    updateStick(stickRight, controls.roll, controls.pitch);
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
      const gateEvent = course.update(drone.position, dt);
      if (gateEvent) {
        // Restart the CSS animation even if the previous flash is mid-run.
        passFlash.className = '';
        void passFlash.offsetWidth;
        passFlash.classList.add(gateEvent);
      }
      updateGateHud();
    }

    if (!osd.hidden) updateOsd();

    updateStick(stickLeft, controls.yaw, controls.throttle * 2 - 1);
    updateStick(stickRight, controls.roll, controls.pitch);
  }

  world.update(drone.position);

  updateCamera();
  world.fadeNear(camera.position, cameraMode.value !== 'fpv');
  updateSun(drone.position);
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
