/**
 * Infinite procedurally generated world.
 *
 * Obstacles are generated in square chunks keyed by chunk coordinates. Each
 * chunk seeds its own PRNG from its coordinates, so any chunk is identical
 * every time it is visited — the world is deterministic yet unbounded.
 * Chunks stream in around the drone and are disposed once out of range.
 * The ground plane and grid are finite meshes that follow the drone,
 * snapped to the grid cell size so the floor appears static.
 */

import * as THREE from 'three';

/** Side length of one obstacle chunk, meters. */
const CHUNK_SIZE = 45;
/** Obstacle grid cell size inside a chunk, meters. */
const CELL = 9;
/** Chunks are kept loaded within this Chebyshev radius of the drone. */
const VIEW_RADIUS = 3;
/** Radius around the world origin kept free of obstacles (spawn pad). */
const SPAWN_CLEAR_RADIUS = 8;
/** World seed mixed into every chunk seed. */
const WORLD_SEED = 0xD90E5;

/** Mirror's Edge palette: mostly white city with red/orange/blue accents. */
const BOX_COLORS = [
  0xF5F7F8, 0xF5F7F8, 0xF5F7F8, 0xE8ECEE, 0xDDE3E6,
  0xE0301E, 0xF39C12, 0x4FA3D9,
];

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
 * Mix chunk coordinates into a single 32-bit seed.
 * @param {number} cx Chunk x coordinate.
 * @param {number} cz Chunk z coordinate.
 * @returns {number}
 */
function chunkSeed(cx, cz) {
  return (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ WORLD_SEED) | 0;
}

/** Streams deterministic obstacle chunks around a focus point. */
export class World {
  /**
   * @param {THREE.Scene} scene Scene to attach world geometry to.
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, {group: THREE.Group, colliders: THREE.Box3[]}>} */
    this.chunks = new Map();
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    /** Shared materials: one per palette color, reused by every box. */
    this.materials = BOX_COLORS.map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 })
    );

    const groundSpan = CHUNK_SIZE * (VIEW_RADIUS * 2 + 1);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSpan, groundSpan),
      new THREE.MeshStandardMaterial({ color: 0xE8ECEE, roughness: 1 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    scene.add(this.ground);

    this.grid = new THREE.GridHelper(groundSpan, groundSpan / CELL, 0xC9D1D6, 0xD8DEE2);
    this.grid.position.y = 0.01;
    scene.add(this.grid);
  }

  /**
   * Stream chunks and recenter the ground around the given position.
   * @param {THREE.Vector3} position Drone position.
   */
  update(position) {
    const ccx = Math.floor(position.x / CHUNK_SIZE);
    const ccz = Math.floor(position.z / CHUNK_SIZE);

    for (let cx = ccx - VIEW_RADIUS; cx <= ccx + VIEW_RADIUS; cx++) {
      for (let cz = ccz - VIEW_RADIUS; cz <= ccz + VIEW_RADIUS; cz++) {
        const key = `${cx},${cz}`;
        if (!this.chunks.has(key)) this.chunks.set(key, this.buildChunk(cx, cz));
      }
    }
    for (const [key, chunk] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > VIEW_RADIUS) {
        this.scene.remove(chunk.group);
        this.chunks.delete(key);
      }
    }

    // Snap to the grid cell so the floor pattern doesn't visibly slide.
    const snapX = Math.round(position.x / CELL) * CELL;
    const snapZ = Math.round(position.z / CELL) * CELL;
    this.ground.position.set(snapX, 0, snapZ);
    this.grid.position.set(snapX, 0.01, snapZ);
  }

  /**
   * Deterministically generate one chunk of obstacles.
   * @param {number} cx Chunk x coordinate.
   * @param {number} cz Chunk z coordinate.
   * @returns {{group: THREE.Group, colliders: THREE.Box3[]}}
   */
  buildChunk(cx, cz) {
    const rand = mulberry32(chunkSeed(cx, cz));
    const group = new THREE.Group();
    /** @type {THREE.Box3[]} */
    const colliders = [];
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    for (let gx = CELL / 2; gx < CHUNK_SIZE; gx += CELL) {
      for (let gz = CELL / 2; gz < CHUNK_SIZE; gz += CELL) {
        if (rand() < 0.35) continue; // leave gaps to fly through

        const x = originX + gx + (rand() - 0.5) * CELL * 0.5;
        const z = originZ + gz + (rand() - 0.5) * CELL * 0.5;
        const w = 1.5 + rand() * 2.5;
        const h = 2 + rand() * 9;
        const d = 1.5 + rand() * 2.5;
        const material = this.materials[Math.floor(rand() * this.materials.length)];
        if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS) continue;

        const box = new THREE.Mesh(this.boxGeo, material);
        box.scale.set(w, h, d);
        box.position.set(x, h / 2, z);
        group.add(box);

        colliders.push(new THREE.Box3(
          new THREE.Vector3(x - w / 2, 0, z - d / 2),
          new THREE.Vector3(x + w / 2, h, z + d / 2)
        ));
      }
    }
    this.scene.add(group);
    return { group, colliders };
  }

  /**
   * Test a sphere (the drone) against obstacles in the chunks around it.
   * @param {THREE.Vector3} center Sphere center.
   * @param {number} radius Sphere radius.
   * @returns {boolean} True on intersection.
   */
  collides(center, radius) {
    const ccx = Math.floor(center.x / CHUNK_SIZE);
    const ccz = Math.floor(center.z / CHUNK_SIZE);
    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
        const chunk = this.chunks.get(`${cx},${cz}`);
        if (!chunk) continue;
        for (const box of chunk.colliders) {
          if (box.distanceToPoint(center) < radius) return true;
        }
      }
    }
    return false;
  }
}
