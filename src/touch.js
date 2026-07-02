/**
 * On-screen dual virtual joysticks for touch play (Mode 2 gimbal layout).
 *
 * Left pad  → throttle (vertical, HOLDS position on release) + yaw (horizontal, springs to center).
 * Right pad → pitch (vertical) + roll (horizontal), both spring to center.
 *
 * The left throttle axis deliberately does not self-center — it mirrors a real
 * Mode 2 gimbal, so lifting the thumb leaves the drone at its current power
 * instead of dropping it to idle.
 *
 * Output matches the InputManager convention: throttle 0..1, the rest -1..1.
 */

/** Max distance (px) the knob center travels from its base center. */
const TRAVEL = 64;

/**
 * Clamp a value into [-1, 1].
 * @param {number} v Value to clamp.
 * @returns {number}
 */
function clamp(v) {
  return Math.max(-1, Math.min(1, v));
}

/**
 * @typedef {Object} Pad
 * @property {HTMLElement} root Circular touch zone (also the visible base).
 * @property {HTMLElement} knob Draggable indicator.
 * @property {number | null} pointerId Active pointer, or null when idle.
 */

/** Owns the touch-joystick DOM and exposes one normalized reading per frame. */
export class TouchControls {
  /**
   * Whether the current device reports touch support.
   * @returns {boolean}
   */
  static isSupported() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  constructor() {
    /** @type {number} 0..1 */
    this.throttle = 0;
    /** @type {number} -1..1 */
    this.yaw = 0;
    /** @type {number} -1..1 */
    this.pitch = 0;
    /** @type {number} -1..1 */
    this.roll = 0;
    /** True while at least one pad is under a finger. */
    this.active = false;

    this.injectStyle();
    const container = document.createElement('div');
    container.id = 'touch-controls';
    this.left = this.createPad('left');
    this.right = this.createPad('right');
    container.append(this.left.root, this.right.root);
    document.body.appendChild(container);

    this.bindPad(this.left, true);
    this.bindPad(this.right, false);

    // Rest the throttle knob at the bottom (idle) and the right knob centered.
    this.apply(this.left, true, 0, -1);
    this.apply(this.right, false, 0, 0);
  }

  /** Inject the pad styling once. */
  injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #touch-controls { position: fixed; inset: 0; z-index: 20; pointer-events: none; }
      #touch-controls .touch-pad {
        position: absolute; bottom: 5vh; width: 180px; height: 180px;
        border-radius: 50%; pointer-events: auto; touch-action: none;
        border: 1px solid var(--me-gray); background: rgba(255, 255, 255, 0.35);
        backdrop-filter: blur(2px);
      }
      #touch-controls .touch-pad.left { left: 4vw; }
      #touch-controls .touch-pad.right { right: 4vw; }
      #touch-controls .touch-knob {
        position: absolute; left: 50%; top: 50%; width: 64px; height: 64px;
        border-radius: 50%; background: var(--me-red);
        box-shadow: 0 2px 8px rgba(27, 30, 32, 0.3);
        transform: translate(-50%, -50%);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Build one pad element with its knob.
   * @param {'left' | 'right'} side CSS anchor class.
   * @returns {Pad}
   */
  createPad(side) {
    const root = document.createElement('div');
    root.className = `touch-pad ${side}`;
    const knob = document.createElement('div');
    knob.className = 'touch-knob';
    root.appendChild(knob);
    return { root, knob, pointerId: null };
  }

  /**
   * Wire pointer events for a pad. Each pad captures its own pointer, so the
   * two sticks track independent fingers.
   * @param {Pad} pad Pad to bind.
   * @param {boolean} isLeft True for the throttle/yaw pad.
   */
  bindPad(pad, isLeft) {
    const down = (e) => {
      if (pad.pointerId !== null) return;
      pad.pointerId = e.pointerId;
      pad.root.setPointerCapture(e.pointerId);
      this.active = true;
      this.moveTo(pad, isLeft, e);
      e.preventDefault();
    };
    const move = (e) => {
      if (e.pointerId !== pad.pointerId) return;
      this.moveTo(pad, isLeft, e);
      e.preventDefault();
    };
    const up = (e) => {
      if (e.pointerId !== pad.pointerId) return;
      pad.pointerId = null;
      this.release(pad, isLeft);
      this.active = this.left.pointerId !== null || this.right.pointerId !== null;
      e.preventDefault();
    };
    pad.root.addEventListener('pointerdown', down);
    pad.root.addEventListener('pointermove', move);
    pad.root.addEventListener('pointerup', up);
    pad.root.addEventListener('pointercancel', up);
  }

  /**
   * Update a pad from a pointer event, normalizing against the base center.
   * @param {Pad} pad Pad being dragged.
   * @param {boolean} isLeft True for the throttle/yaw pad.
   * @param {PointerEvent} e Pointer event.
   */
  moveTo(pad, isLeft, e) {
    const rect = pad.root.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const nx = clamp((e.clientX - cx) / TRAVEL);
    const ny = clamp((cy - e.clientY) / TRAVEL); // up = positive
    this.apply(pad, isLeft, nx, ny);
  }

  /**
   * Commit normalized axes to the knob transform and the output channels.
   * @param {Pad} pad Pad being updated.
   * @param {boolean} isLeft True for the throttle/yaw pad.
   * @param {number} nx Horizontal axis in [-1, 1].
   * @param {number} ny Vertical axis in [-1, 1] (up = +1).
   */
  apply(pad, isLeft, nx, ny) {
    pad.knob.style.transform =
      `translate(calc(-50% + ${nx * TRAVEL}px), calc(-50% + ${-ny * TRAVEL}px))`;
    if (isLeft) {
      this.yaw = nx;
      this.throttle = (ny + 1) / 2;
    } else {
      this.roll = nx;
      this.pitch = ny;
    }
  }

  /**
   * Spring a released pad back: right pad recenters fully; left pad recenters
   * yaw only, holding the throttle at its last height.
   * @param {Pad} pad Pad that was released.
   * @param {boolean} isLeft True for the throttle/yaw pad.
   */
  release(pad, isLeft) {
    if (isLeft) {
      this.apply(pad, true, 0, this.throttle * 2 - 1);
    } else {
      this.apply(pad, false, 0, 0);
    }
  }

  /** Reset all channels to idle (throttle down, sticks centered). */
  reset() {
    this.left.pointerId = null;
    this.right.pointerId = null;
    this.active = false;
    this.apply(this.left, true, 0, -1);
    this.apply(this.right, false, 0, 0);
  }
}
