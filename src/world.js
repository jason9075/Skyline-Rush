/**
 * World construction: ground plane, box obstacle field, and collision tests.
 * Obstacles are placed on a jittered grid with a deterministic PRNG so the
 * course is identical on every load.
 */

import * as THREE from 'three';

/** Half-extent of the flyable area, meters. */
export const WORLD_HALF = 60;
/** Radius around the spawn point kept free of obstacles. */
const SPAWN_CLEAR_RADIUS = 8;

/**
 * Mulberry32 — tiny deterministic PRNG.
 * @param {number} seed 32-bit seed.
 * @returns {() => number} Generator yielding floats in [0, 1).
 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {Object} World
 * @property {THREE.Group} group Scene node containing ground and obstacles.
 * @property {THREE.Box3[]} colliders Static AABBs for collision testing.
 */

/**
 * Build the ground, grid helper, and box obstacle field.
 * @param {THREE.Vector3} spawn Spawn point to keep clear.
 * @returns {World}
 */
export function buildWorld(spawn) {
  const group = new THREE.Group();
  /** @type {THREE.Box3[]} */
  const colliders = [];

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0x3B4252, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const grid = new THREE.GridHelper(WORLD_HALF * 2, 40, 0x4C566A, 0x434C5E);
  grid.position.y = 0.01;
  group.add(grid);

  const palette = [0x88C0D0, 0x81A1C1, 0x5E81AC, 0xB48EAD, 0xEBCB8B, 0xA3BE8C];
  const rand = mulberry32(0xD90E5);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const spacing = 9;

  for (let gx = -WORLD_HALF + spacing; gx < WORLD_HALF; gx += spacing) {
    for (let gz = -WORLD_HALF + spacing; gz < WORLD_HALF; gz += spacing) {
      if (rand() < 0.35) continue; // leave gaps to fly through

      const x = gx + (rand() - 0.5) * spacing * 0.5;
      const z = gz + (rand() - 0.5) * spacing * 0.5;
      if (Math.hypot(x - spawn.x, z - spawn.z) < SPAWN_CLEAR_RADIUS) continue;

      const w = 1.5 + rand() * 2.5;
      const h = 2 + rand() * 9;
      const d = 1.5 + rand() * 2.5;

      const mat = new THREE.MeshStandardMaterial({
        color: palette[Math.floor(rand() * palette.length)],
        roughness: 0.8,
      });
      const box = new THREE.Mesh(boxGeo, mat);
      box.scale.set(w, h, d);
      box.position.set(x, h / 2, z);
      group.add(box);

      colliders.push(new THREE.Box3(
        new THREE.Vector3(x - w / 2, 0, z - d / 2),
        new THREE.Vector3(x + w / 2, h, z + d / 2)
      ));
    }
  }
  return { group, colliders };
}

/**
 * Test a sphere (the drone) against all obstacle AABBs.
 * @param {THREE.Vector3} center Sphere center.
 * @param {number} radius Sphere radius.
 * @param {THREE.Box3[]} colliders Obstacle AABBs.
 * @returns {boolean} True on intersection.
 */
export function collides(center, radius, colliders) {
  for (const box of colliders) {
    if (box.distanceToPoint(center) < radius) return true;
  }
  return false;
}
