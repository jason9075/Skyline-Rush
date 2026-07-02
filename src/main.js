import * as THREE from 'three';
import renderMathInElement from 'katex/dist/contrib/auto-render';
import 'katex/dist/katex.min.css';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript.js';
import 'prism-themes/themes/prism-nord.css';

import { Drone, DRONE_RADIUS } from './drone.js';
import { InputManager } from './input.js';
import { modalCopy } from './modal-content.js';
import { buildWorld, collides, WORLD_HALF } from './world.js';

/* ─── Nord colour palette & layout ────────────────────────────────── */
const style = document.createElement('style');
style.textContent = `
  :root {
    --nord0: #2E3440; --nord1: #3B4252; --nord2: #434C5E; --nord3: #4C566A;
    --nord4: #D8DEE9; --nord5: #E5E9F0; --nord6: #ECEFF4;
    --nord7: #8FBCBB; --nord8: #88C0D0; --nord9: #81A1C1; --nord10: #5E81AC;
    --nord11: #BF616A; --nord12: #D08770; --nord13: #EBCB8B;
    --nord14: #A3BE8C; --nord15: #B48EAD;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--nord0); color: var(--nord4);
    font-family: 'JetBrains Mono', monospace, sans-serif;
    overflow: hidden;
  }
  canvas { display: block; }
  #info {
    position: absolute; top: 1rem; left: 1rem;
    color: var(--nord8); font-size: 0.85rem; z-index: 10;
  }
  #toolbar {
    position: fixed; top: 1rem; left: 50%; transform: translateX(-50%);
    display: flex; gap: 0.75rem; align-items: center;
    padding: 0.75rem 1rem;
    border: 1px solid var(--nord3); border-radius: 999px;
    background: rgba(59, 66, 82, 0.88); backdrop-filter: blur(10px);
    z-index: 20; font-size: 0.85rem;
  }
  #toolbar label, #toolbar select, #toolbar button { font: inherit; }
  #toolbar select, #toolbar button, .modal-toggle {
    border: 1px solid var(--nord3); border-radius: 999px;
    background: var(--nord1); color: var(--nord6);
    padding: 0.45rem 0.8rem; cursor: pointer;
  }
  .icon-button { font-size: 1.1rem; line-height: 1; }
  #hud {
    position: fixed; bottom: 1rem; left: 1rem; z-index: 10;
    display: grid; gap: 0.5rem; font-size: 0.8rem;
  }
  #gamepad-status { color: var(--nord13); }
  #telemetry { color: var(--nord8); }
  #help-text { color: var(--nord3); max-width: 34rem; line-height: 1.5; }
  #sticks { display: flex; gap: 0.75rem; }
  .stick {
    position: relative; width: 64px; height: 64px;
    border: 1px solid var(--nord3); border-radius: 8px;
    background: rgba(59, 66, 82, 0.6);
  }
  .stick-dot {
    position: absolute; left: 50%; top: 50%; width: 10px; height: 10px;
    border-radius: 50%; background: var(--nord8);
    transform: translate(-50%, -50%);
  }
  #crash-banner {
    position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%);
    color: var(--nord11); font-size: 2rem; font-weight: bold;
    text-shadow: 0 0 24px rgba(191, 97, 106, 0.6); z-index: 30;
  }
  #crash-banner[hidden] { display: none; }
  #math-modal[hidden] { display: none; }
  #math-modal {
    position: fixed; inset: 0; display: grid; place-items: center;
    background: rgba(46, 52, 64, 0.78); z-index: 50;
  }
  .modal-panel {
    width: min(720px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem);
    overflow: auto; background: var(--nord1);
    border: 1px solid var(--nord3); border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.35); padding: 1.25rem;
  }
  .modal-header {
    display: flex; justify-content: space-between; align-items: center;
    gap: 1rem; margin-bottom: 1rem;
  }
  .modal-header h2 { font-size: 1rem; color: var(--nord8); }
  .modal-actions { display: flex; gap: 0.5rem; align-items: center; }
  .modal-body { display: grid; gap: 0.85rem; line-height: 1.7; color: var(--nord5); }
  .modal-body pre[class*="language-"] {
    border-radius: 8px; overflow-x: auto; font-size: 0.82rem; margin: 0;
  }
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
const openMathButton = document.getElementById('open-math');
const closeMathButton = document.getElementById('close-math');
const languageToggle = document.getElementById('language-toggle');
const mathModal = document.getElementById('math-modal');
const mathContent = document.getElementById('math-content');

/* ─── Three.js scene ──────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2E3440);
scene.fog = new THREE.Fog(0x2E3440, 40, 120);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300);

const sun = new THREE.DirectionalLight(0xECEFF4, 1.6);
sun.position.set(30, 50, 20);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x81A1C1, 0.7));
scene.add(new THREE.HemisphereLight(0xECEFF4, 0x3B4252, 0.5));

const SPAWN = new THREE.Vector3(0, 1.5, 0);
const world = buildWorld(SPAWN);
scene.add(world.group);

const drone = new Drone(SPAWN);
scene.add(drone.mesh);

const input = new InputManager((status) => {
  gamepadStatus.textContent = status;
});

/* ─── State ───────────────────────────────────────────────────────── */
let modalLanguage = 'en';
let crashTimer = 0;

/* ─── Crash & reset ───────────────────────────────────────────────── */
/** Trigger the crash banner and schedule a respawn. */
function crash() {
  crashTimer = 1.2;
  crashBanner.hidden = false;
}

/** Immediately respawn the drone. */
function resetDrone() {
  drone.reset();
  input.reset();
  crashTimer = 0;
  crashBanner.hidden = true;
}

/* ─── Camera ──────────────────────────────────────────────────────── */
const cameraTarget = new THREE.Vector3();

/** Position the camera for the selected mode. */
function updateCamera() {
  const mode = cameraMode.value;
  if (mode === 'fpv') {
    camera.position.copy(drone.position);
    camera.quaternion.setFromEuler(new THREE.Euler(drone.pitch, drone.yaw + Math.PI, drone.roll, 'YXZ'));
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

/* ─── Modal ───────────────────────────────────────────────────────── */
function renderModalContent() {
  mathContent.innerHTML = modalCopy[modalLanguage];
  renderMathInElement(mathContent, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
  });
  Prism.highlightAllUnder(mathContent);
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

resetButton.addEventListener('click', resetDrone);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') resetDrone();
});

openMathButton.addEventListener('click', () => {
  renderModalContent();
  mathModal.hidden = false;
});

closeMathButton.addEventListener('click', () => {
  mathModal.hidden = true;
});

languageToggle.addEventListener('click', () => {
  modalLanguage = modalLanguage === 'en' ? 'zhTW' : 'en';
  renderModalContent();
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
let lastTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);
  // Clamp dt so a background tab doesn't produce one giant physics step.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (crashTimer > 0) {
    crashTimer -= dt;
    if (crashTimer <= 0) resetDrone();
  } else {
    const controls = input.poll(dt);
    drone.update(controls, dt);

    // Keep the drone inside the world bounds.
    drone.position.x = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, drone.position.x));
    drone.position.z = Math.max(-WORLD_HALF, Math.min(WORLD_HALF, drone.position.z));

    // Ground contact: gentle touch lands, hard impact crashes.
    if (drone.position.y < DRONE_RADIUS) {
      if (drone.velocity.y < -4) {
        crash();
      } else {
        drone.position.y = DRONE_RADIUS;
        drone.velocity.y = Math.max(0, drone.velocity.y);
      }
    }

    if (collides(drone.position, DRONE_RADIUS, world.colliders)) crash();

    updateStick(stickLeft, controls.yaw, controls.throttle * 2 - 1);
    updateStick(stickRight, controls.roll, controls.pitch);
    telemetry.textContent =
      `ALT ${drone.position.y.toFixed(1)} m | SPD ${drone.speed().toFixed(1)} m/s`;
  }

  updateCamera();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
