import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import hdrSkyUrl from '../assets/kloofendal_48d_partly_cloudy_puresky_1k.hdr?url';
import { loadBuildingPool } from './buildings.js';
import { ControlsUI } from './controls-ui.js';
import { Drone, DRONE_RADIUS } from './drone.js';
import { GateCourse } from './gates.js';
import { InputManager } from './input.js';
import { StrikeMission, DRONE_HP, BOMB_MAX } from './strike.js';
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
  /* Topmost layer (above the ready overlay at 40, the binding/rates overlays
     at 45, and the HUD at 46) so settings stay adjustable on the start screen. */
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
  /* Above the ready and binding/rates overlays (40/45) so the sticks stay
     visible for verifying the controller before starting. */
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
  /* Countdown shares the HUD's red; pulses in the final 10 seconds. */
  #gate-timer.urgent { animation: timer-pulse 1s steps(1) infinite; }
  @keyframes timer-pulse { 50% { opacity: 0.35; } }
  /* Strike HUD mirrors the gate HUD; the HP glyph bar drains as blocks lose
     their color, and flashes red the moment the drone is hit. */
  #strike-hud {
    position: fixed; top: 1rem; left: 50%; transform: translateX(-50%);
    display: flex; gap: 1.2rem; align-items: center; z-index: 46;
    color: var(--me-red); font-weight: 800; font-size: 1rem;
    letter-spacing: 0.05em; font-family: monospace; white-space: nowrap;
  }
  #strike-hud[hidden] { display: none; }
  #strike-hp .spent { color: rgba(27, 30, 32, 0.22); }
  #strike-hud.hit { animation: strike-hit 0.25s steps(1); }
  @keyframes strike-hit { 0%, 60% { color: #fff; text-shadow: 0 0 8px var(--me-red); } }
  /* Bomb icon + drop control, bottom-center. Doubles as the stock display: a
     recharging bomb darkens and refills bottom-up, and a notification-style
     red badge on the lower-right shows how many bombs are ready. */
  #drop-button {
    position: fixed; bottom: 1.5rem; left: 50%; margin-left: -2rem;
    width: 4rem; height: 4rem; border-radius: 50%; z-index: 47;
    border: 2px solid var(--me-red); background: rgba(250, 251, 252, 0.75);
    backdrop-filter: blur(6px); cursor: pointer; padding: 0;
    user-select: none; touch-action: manipulation;
  }
  #drop-button[hidden] { display: none; }
  /* On touch, tuck the button against the right edge, above the right stick. */
  body.touch #drop-button {
    left: auto; margin-left: 0; transform: none;
    right: calc(0.6rem + env(safe-area-inset-right, 0px));
    bottom: calc(5vh + 180px + 0.75rem);
  }
  /* Clips the recharge fill to the circle; the badge lives outside this so it
     isn't cropped by the rounded corner. */
  #drop-button .drop-face {
    position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
  }
  #drop-button .drop-fill {
    position: absolute; left: 0; right: 0; bottom: 0;
    height: calc(var(--p, 0) * 100%); background: rgba(224, 48, 30, 0.3);
    transition: height 0.1s linear;
  }
  #drop-button .drop-glyph {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 1.7rem; line-height: 1; z-index: 1;
  }
  /* Recharging: the face reads as a shadow until the fill climbs over it. */
  #drop-button.charging { background: rgba(27, 30, 32, 0.5); }
  #drop-button.charging .drop-glyph { filter: grayscale(0.7) brightness(0.65); }
  #drop-button:active { background: var(--me-red); }
  #drop-button:disabled { cursor: not-allowed; }
  #drop-button .drop-count {
    position: absolute; right: -4px; bottom: -4px; z-index: 3;
    min-width: 1.3rem; height: 1.3rem; padding: 0 0.25rem; box-sizing: border-box;
    border-radius: 0.75rem; background: var(--me-red); color: #fff;
    font: 700 0.82rem/1.3rem monospace; text-align: center;
    box-shadow: 0 0 0 2px rgba(250, 251, 252, 0.95);
  }
  /* Pop the icon each time a bomb finishes charging (centering is off transform
     now, so a plain scale works for both the desktop and touch placements). */
  #drop-button.pop { animation: bomb-ready 0.35s ease-out; }
  @keyframes bomb-ready {
    0% { transform: scale(1.25); box-shadow: 0 0 14px var(--me-red); }
    100% { transform: scale(1); box-shadow: none; }
  }
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
  #ready-overlay, #results-overlay {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(250, 251, 252, 0.65); backdrop-filter: blur(4px); z-index: 40;
  }
  #ready-overlay[hidden], #results-overlay[hidden] { display: none; }
  /* Results screen shares the ready panel styling; the score is the hero. */
  #results-score {
    font-family: monospace; font-size: 4.5rem; font-weight: 800;
    color: var(--me-red); line-height: 1;
  }
  .results-label {
    color: var(--me-mid); text-transform: uppercase;
    font-size: 0.75rem; letter-spacing: 0.12em;
  }
  #results-again {
    justify-self: center; font: inherit; font-size: 1rem; cursor: pointer;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 0.7rem 2.2rem; border-radius: 2px;
    border: 1px solid var(--me-red); background: var(--me-red); color: #fff;
  }
  #results-again:hover { background: var(--me-red-dark); border-color: var(--me-red-dark); }
  .ready-panel {
    position: relative;
    width: min(520px, calc(100vw - 2rem)); padding: 2rem;
    background: var(--me-panel); border: 1px solid var(--me-gray); border-radius: 2px;
    border-top: 4px solid var(--me-red);
    box-shadow: 0 20px 60px rgba(27, 30, 32, 0.18);
    display: grid; gap: 1rem; text-align: center;
  }
  /* Source link, pinned to the panel corner. */
  #github-link {
    position: absolute; top: 1rem; right: 1rem;
    display: inline-flex; color: var(--me-mid); transition: color 0.15s;
  }
  #github-link:hover { color: var(--me-red); }
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
  .calib-actions { display: flex; gap: 0.5rem; justify-content: center; }
  .calib-actions button { font: inherit; }
  #binding-overlay {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(250, 251, 252, 0.65); backdrop-filter: blur(4px); z-index: 45;
  }
  #binding-overlay[hidden] { display: none; }
  #bind-instruction { min-height: 3em; }
  #bind-status { color: var(--me-orange); font-size: 0.8rem; min-height: 1.4em; font-weight: 700; }
  #bind-next {
    cursor: pointer; padding: 0.5rem 1.4rem; border-radius: 2px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    border: 1px solid var(--me-red); background: var(--me-red); color: #fff;
  }
  #bind-next:hover { background: var(--me-red-dark); }
  #bind-next[hidden] { display: none; }
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
  /* The Space/Enter footnote is keyboard-specific; hide it on touch. */
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

/* ─── Input configuration UI ──────────────────────────────────────── */
const controlsUi = new ControlsUI(input, isTouch, saveSettings);

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
/** Last-seen bomb stock, so the icon pops exactly once when a bomb recharges. */
let prevBombStock = 0;

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
  gateHud.hidden = !course;
  strikeHud.hidden = !strike;
  dropButton.hidden = !strike;
  if (strike) {
    prevBombStock = strike.bombStock; // no spurious pop on the opening stock
    updateStrikeHud();
  }
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
  // In Strike a city impact ends the mission and tallies the kills scored so
  // far, the same as being shot down — there is no checkpoint to resume from.
  if (strike) { finishStrike(); return; }
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
  resumeRun = false;
  flightState = 'ready';
  crashTimer = 0;
  crashCamOrigin = null;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = autoStart;
  readyOverlay.hidden = autoStart;
  rebuildMode();
  syncOsdVisibility();
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
  syncOsdVisibility();
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
  syncOsdVisibility();
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
  syncOsdVisibility();
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
  strikeHud.hidden = true;
  dropButton.hidden = true;
  crashBanner.hidden = true;
  armBanner.hidden = true;
  pendingAutoStart = false;
  syncOsdVisibility();
}

/**
 * Drop a bomb from the current drone pose (Strike mode, in flight). The bomb
 * inherits the drone's velocity; stock is spent inside the mission.
 */
function dropBomb() {
  if (!strike || flightState !== 'flying') return;
  strike.dropBomb(drone.position, drone.velocity);
  updateStrikeHud();
}

/**
 * Refresh the Strike HUD: enemies left, the HP glyph bar, and the bottom-center
 * bomb icon. While the stock is below capacity the icon darkens and refills
 * bottom-up over the recharge; the red badge shows the ready count and the icon
 * pops each time a bomb finishes charging.
 */
function updateStrikeHud() {
  if (!strike) return;
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

  if (stock > prevBombStock) {
    dropButton.classList.remove('pop');
    void dropButton.offsetWidth;
    dropButton.classList.add('pop');
  }
  prevBombStock = stock;
}

/**
 * Format a duration as M:SS.
 * @param {number} seconds Seconds remaining (clamped at 0).
 * @returns {string}
 */
function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
    godMode: godModeCheckbox.checked,
    osd: osdCheckbox.checked,
    ...controlsUi.collectSettings(),
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
  if (typeof s.godMode === 'boolean') godModeCheckbox.checked = s.godMode;
  if (typeof s.osd === 'boolean') osdCheckbox.checked = s.osd;
  controlsUi.applySettings(s);

  drone.flightMode = flightMode.value;
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
});

flightMode.addEventListener('change', (e) => {
  drone.flightMode = e.target.value;
});

osdCheckbox.addEventListener('change', syncOsdVisibility);

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
controlsUi.init();
syncGameModeUi();
syncCameraPitch();
syncOsdVisibility();

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
  gateTimer.textContent = formatTime(gateTimeLeft);
  gateTimer.classList.toggle('urgent', gateTimeLeft < 10);
}

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
        updateGateHud();
      }
    }

    if (strike && flightState === 'flying') {
      const { damage } = strike.update(drone.position, dt, godMode);
      if (damage > 0) {
        // Flash the HP bar red on each hit (restart even mid-animation).
        strikeHud.classList.remove('hit');
        void strikeHud.offsetWidth;
        strikeHud.classList.add('hit');
      }
      updateStrikeHud();
      if (strike.status !== 'active') finishStrike();
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
