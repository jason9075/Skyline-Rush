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

/** Bounding sphere radius used for collision, meters. */
export const DRONE_RADIUS = 0.45;

/**
 * Build the visual quadcopter mesh (frame, four arms, rotors, canopy).
 * @returns {THREE.Group}
 */
function buildDroneMesh() {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x4C566A, roughness: 0.6 });
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x88C0D0,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
  });
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0xBF616A, roughness: 0.4 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.5), frameMat);
  group.add(body);

  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.22), canopyMat);
  canopy.position.set(0, 0.1, -0.08);
  group.add(canopy);

  const armGeo = new THREE.BoxGeometry(0.75, 0.04, 0.07);
  const rotorGeo = new THREE.CircleGeometry(0.22, 24);
  const rotorPositions = [
    [0.32, -0.32],
    [-0.32, -0.32],
    [0.32, 0.32],
    [-0.32, 0.32],
  ];

  for (const [i, [x, z]] of rotorPositions.entries()) {
    const arm = new THREE.Mesh(armGeo, frameMat);
    arm.position.set(x / 2, 0, z / 2);
    arm.rotation.y = Math.atan2(-z, x);
    group.add(arm);

    const rotor = new THREE.Mesh(rotorGeo, rotorMat);
    rotor.rotation.x = -Math.PI / 2;
    rotor.position.set(x, 0.05, z);
    rotor.name = `rotor-${i}`;
    group.add(rotor);
  }
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
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    /** Last commanded throttle, kept for rotor spin animation. */
    this.throttle = 0;
    this.syncMesh();
  }

  /**
   * Advance physics by one step.
   * @param {import('./input.js').ControlInput} input Normalized stick input.
   * @param {number} dt Time step in seconds.
   */
  update(input, dt) {
    this.throttle = input.throttle;

    // Yaw is a rate command; pitch/roll are angle commands (angle mode).
    this.yaw -= input.yaw * YAW_RATE * dt;
    const targetPitch = -input.pitch * MAX_TILT;
    const targetRoll = -input.roll * MAX_TILT;
    const blend = Math.min(1, TILT_RESPONSE * dt);
    this.pitch += (targetPitch - this.pitch) * blend;
    this.roll += (targetRoll - this.roll) * blend;

    // Thrust acts along the body-up axis; gravity and drag oppose motion.
    const orientation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, this.roll, 'YXZ')
    );
    const thrustAccel = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(orientation)
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
    this.mesh.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    const spin = 0.3 + this.throttle * 1.2;
    for (let i = 0; i < 4; i++) {
      const rotor = this.mesh.getObjectByName(`rotor-${i}`);
      if (rotor) rotor.rotation.z += (i % 2 === 0 ? spin : -spin);
    }
  }

  /** Return the drone to its spawn point with zeroed state. */
  reset() {
    this.position.copy(this.spawn);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
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
