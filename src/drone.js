/**
 * Quadcopter model and simplified angle-mode flight dynamics.
 *
 * The drone is a rigid body driven by a single thrust vector along its
 * body-up axis. Sticks command tilt angles directly (self-leveling
 * "angle mode"), yaw commands a rotation rate, and throttle commands
 * total thrust. Translation integrates Newton's second law with linear drag.
 */

import * as THREE from 'three';

const GRAVITY = 9.81;
/** Max thrust acceleration in m/s² (~2.5g, so hover sits near 40% throttle). */
const MAX_THRUST = 25;
/** Max commanded tilt in radians (~35°). */
const MAX_TILT = 0.6;
/** Yaw rate at full stick, rad/s. */
const YAW_RATE = 2.6;
/** Linear drag coefficient, 1/s. */
const DRAG = 0.4;
/** How quickly the body eases toward the commanded tilt, 1/s. */
const TILT_RESPONSE = 8;
/** Pitch/roll rotation rate at full stick in acro mode, rad/s (~600°/s). */
const ACRO_RATE = 10.5;

/** Bounding sphere radius used for collision, meters. */
export const DRONE_RADIUS = 0.45;

/**
 * Build the visual quadcopter mesh: a twin-plate carbon frame with an FPV
 * camera pod, metallic motors, and true 2-blade propellers. The solid blades
 * are visible at rest; a translucent blur disc crossfades in as they spin up
 * (opacities animated in {@link Drone#syncMesh}). Shared blade/disc materials
 * are stashed on `group.userData` for that crossfade.
 * @returns {THREE.Group}
 */
function buildDroneMesh() {
  const group = new THREE.Group();

  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x17191B, roughness: 0.45, metalness: 0.4 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xE0301E, roughness: 0.35, metalness: 0.1 });
  const motorMat = new THREE.MeshStandardMaterial({ color: 0x9AA1A6, roughness: 0.3, metalness: 0.85 });
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x2A2E31, roughness: 0.5, metalness: 0.2, transparent: true, side: THREE.DoubleSide,
  });
  const discMat = new THREE.MeshStandardMaterial({
    color: 0xE0301E, roughness: 0.4, transparent: true, opacity: 0,
    side: THREE.DoubleSide, depthWrite: false,
  });

  // Twin-plate carbon stack.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.5), carbonMat);
  lower.position.y = -0.02;
  group.add(lower);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.045, 0.34), carbonMat);
  upper.position.y = 0.055;
  group.add(upper);

  // FPV camera pod up front (drone faces -Z), tilted back like a real quad.
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.13, 0.13), accentMat);
  pod.position.set(0, 0.12, -0.16);
  pod.rotation.x = -0.3;
  group.add(pod);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.05, 14), motorMat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0.14, -0.24);
  group.add(lens);

  const armGeo = new THREE.BoxGeometry(0.44, 0.028, 0.05);
  const motorGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.08, 16);
  const hubGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.04, 10);
  const PROP_R = 0.24;
  const bladeGeo = new THREE.BoxGeometry(PROP_R * 2, 0.006, 0.055);
  const discGeo = new THREE.CircleGeometry(PROP_R, 28);
  const rotorPositions = [
    [0.3, -0.3],
    [-0.3, -0.3],
    [0.3, 0.3],
    [-0.3, 0.3],
  ];

  for (const [i, [x, z]] of rotorPositions.entries()) {
    const arm = new THREE.Mesh(armGeo, carbonMat);
    arm.position.set(x / 2, -0.01, z / 2);
    arm.rotation.y = Math.atan2(-z, x);
    group.add(arm);

    const motor = new THREE.Mesh(motorGeo, motorMat);
    motor.position.set(x, 0.03, z);
    group.add(motor);

    // Spinning assembly: 2-blade prop + hub, spun about Y by syncMesh.
    const prop = new THREE.Group();
    prop.position.set(x, 0.09, z);
    prop.name = `rotor-${i}`;
    prop.add(new THREE.Mesh(bladeGeo, bladeMat));
    prop.add(new THREE.Mesh(hubGeo, motorMat));
    group.add(prop);

    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.095, z);
    disc.name = `disc-${i}`;
    group.add(disc);
  }

  // The blur disc must not cast a (permanent, opacity-blind) shadow at idle.
  group.traverse((o) => { if (o.isMesh) o.castShadow = !o.name.startsWith('disc-'); });
  group.userData.bladeMat = bladeMat;
  group.userData.discMat = discMat;
  return group;
}

/** Simulated quadcopter: owns its mesh and integrates flight physics. */
export class Drone {
  /**
   * @param {THREE.Vector3} spawnPosition World-space spawn point.
   */
  constructor(spawnPosition) {
    /** @type {THREE.Group} */
    this.mesh = buildDroneMesh();
    /** @type {THREE.Vector3} */
    this.spawn = spawnPosition.clone();
    /** @type {THREE.Vector3} */
    this.position = spawnPosition.clone();
    /** @type {THREE.Vector3} */
    this.velocity = new THREE.Vector3();
    /**
     * Body orientation and single source of truth for attitude. Acro integrates
     * body-frame angular velocity onto it; level rebuilds it from a heading +
     * clamped tilt setpoint. {@link Drone#pitch}/{@link Drone#yaw}/
     * {@link Drone#roll} are derived from it each frame for the HUD/camera.
     * @type {THREE.Quaternion}
     */
    this.orientation = new THREE.Quaternion();
    /** Heading setpoint for level mode (yaw is a rate integrated onto this). */
    this.heading = 0;
    // Read-only Euler view of `orientation` (order YXZ), refreshed each update.
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    /** Last commanded throttle, kept for rotor spin animation. */
    this.throttle = 0;
    /** @type {'level'|'acro'} 'level' self-levels to a max tilt; 'acro' commands raw rotation rates (flips/rolls). */
    this.flightMode = 'level';
    /** Previous mode, to seed the heading setpoint when switching into level. */
    this._prevMode = this.flightMode;
    this.syncMesh();
  }

  /**
   * Advance physics by one step.
   * @param {import('./input.js').ControlInput} input Normalized stick input.
   * @param {number} dt Time step in seconds.
   */
  update(input, dt) {
    this.throttle = input.throttle;

    // Entering level from acro: seed the heading setpoint from the current
    // actual heading so self-leveling doesn't snap the yaw. (Tilt continuity is
    // automatic — the level branch reads current tilt back off `orientation`.)
    if (this.flightMode !== this._prevMode) {
      if (this.flightMode === 'level') {
        this.heading = new THREE.Euler().setFromQuaternion(this.orientation, 'YXZ').y;
      }
      this._prevMode = this.flightMode;
    }

    if (this.flightMode === 'acro') {
      // Rate mode: integrate body-frame angular velocity onto the orientation
      // quaternion (right-multiply = local frame). Unlike accumulating Euler
      // components, this stays correct through full flips and rolls — no gimbal
      // coupling that would reverse pitch after a 180° roll.
      const omega = new THREE.Vector3(
        -input.pitch * ACRO_RATE,
        -input.yaw * YAW_RATE,
        -input.roll * ACRO_RATE,
      ).multiplyScalar(dt);
      const angle = omega.length();
      if (angle > 1e-8) {
        this.orientation
          .multiply(new THREE.Quaternion().setFromAxisAngle(omega.divideScalar(angle), angle))
          .normalize();
      }
    } else {
      // Angle mode: yaw is a full-rate heading command; pitch/roll ease toward a
      // tilt clamped to MAX_TILT. Reading current tilt back off `orientation`
      // keeps the self-leveling dynamics identical to the old Euler model while
      // the quaternion stays the single source of truth.
      this.heading -= input.yaw * YAW_RATE * dt;
      const cur = new THREE.Euler().setFromQuaternion(this.orientation, 'YXZ');
      const blend = Math.min(1, TILT_RESPONSE * dt);
      const pitch = cur.x + (-input.pitch * MAX_TILT - cur.x) * blend;
      const roll = cur.z + (-input.roll * MAX_TILT - cur.z) * blend;
      this.orientation.setFromEuler(new THREE.Euler(pitch, this.heading, roll, 'YXZ'));
    }

    // Derived read-only Euler view (order YXZ) for the HUD/camera in main.js.
    const e = new THREE.Euler().setFromQuaternion(this.orientation, 'YXZ');
    this.pitch = e.x;
    this.yaw = e.y;
    this.roll = e.z;

    // Thrust acts along the body-up axis; gravity and drag oppose motion.
    const thrustAccel = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(this.orientation)
      .multiplyScalar(input.throttle * MAX_THRUST);

    const accel = thrustAccel
      .add(new THREE.Vector3(0, -GRAVITY, 0))
      .addScaledVector(this.velocity, -DRAG);

    this.velocity.addScaledVector(accel, dt);
    this.position.addScaledVector(this.velocity, dt);
    this.syncMesh();
  }

  /** Copy the physics state onto the Three.js mesh and spin the rotors. */
  syncMesh() {
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.orientation);
    // Props are stopped at idle (so the blades read clearly, e.g. on the ready
    // screen) and spin up with throttle, alternating direction like a real
    // quad. As they spin, the solid blades fade into the blur disc.
    const spin = this.throttle * 1.4;
    for (let i = 0; i < 4; i++) {
      const rotor = this.mesh.getObjectByName(`rotor-${i}`);
      if (rotor) rotor.rotation.y += (i % 2 === 0 ? spin : -spin);
    }
    const blur = Math.min(1, this.throttle / 0.22);
    const { bladeMat, discMat } = this.mesh.userData;
    if (bladeMat) bladeMat.opacity = 1 - 0.8 * blur;
    if (discMat) discMat.opacity = 0.5 * blur;
  }

  /** Return the drone to its spawn point with zeroed state. */
  reset() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.orientation.identity();
    this.heading = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.throttle = 0;
    this.syncMesh();
  }

  /**
   * Respawn at an arbitrary pose with zeroed motion, for checkpoint restarts
   * (unlike {@link reset}, which always returns to the origin spawn pad).
   * @param {THREE.Vector3} position World-space respawn point.
   * @param {number} yaw Heading in radians (drone faces local -Z).
   */
  respawn(position, yaw) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.orientation.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    this.heading = yaw;
    this.yaw = yaw;
    this.pitch = 0;
    this.roll = 0;
    this.throttle = 0;
    this.syncMesh();
  }

  /** @returns {number} Ground speed in m/s. */
  speed() {
    return this.velocity.length();
  }
}
