/**
 * Infinite procedurally generated city — geometry layer.
 *
 * Streets, roundabouts, zoning, and building placement all come from the
 * deterministic pure functions in citygen.js. This module turns them into
 * Three.js objects per chunk:
 *   - a ground tile whose texture rasterizes the road field with signed-
 *     distance anti-aliasing (so the spline curves look smooth), and
 *   - one mesh per planned building, sharing pooled geometries/materials.
 *
 * Chunks are identical on every visit, stream in around the drone (at most a
 * couple per frame to avoid hitches), and are disposed once out of range.
 * Collision and camera-fade operate on the placed AABBs.
 */

import * as THREE from 'three';

import { createCityPlanner, sampleCity } from './citygen.js';

/** Side length of one chunk, meters. */
const CHUNK_SIZE = 96;
/** Chunks kept loaded within this Chebyshev radius of the drone. */
const VIEW_RADIUS = 2;
/** Buildings closer than this to the camera are rendered transparent. */
const FADE_DISTANCE = 4;
/** Placeholder ground texture resolution (built synchronously, swapped out). */
const GROUND_RES = 64;
/** High-resolution ground texture, rasterized in a worker (0.1875 m/px). */
const GROUND_RES_HI = 512;

/** Mirror's Edge palette: a mostly white city with sparse accents. */
const BOX_COLORS = [
  0xF5F7F8, 0xF5F7F8, 0xF5F7F8, 0xFFFFFF, 0xE8ECEE, 0xDDE3E6,
  0xE0301E, 0xF39C12, 0x4FA3D9,
];

/** Ground/road tile colors (RGB triplets). */
const COL_GROUND = [232, 236, 238];
const COL_PLAZA = [214, 218, 222];
const COL_MAJOR = [64, 68, 74];
const COL_MINOR = [88, 92, 98];

/** Streams a deterministic city of building instances around a focus point. */
export class World {
  /**
   * @param {THREE.Scene} scene Scene to attach world geometry to.
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {import('./buildings.js').BuildingTemplate[]} */
    this.pool = [];
    /** @type {ReturnType<typeof createCityPlanner> | null} */
    this.planner = null;
    /** @type {Map<string, {group: THREE.Group, tile: THREE.Mesh, texture: THREE.Texture, colliders: {box: THREE.Box3, mesh: THREE.Mesh}[]}>} */
    this.chunks = new Map();

    /** Shared opaque materials, one per palette color. */
    this.materials = BOX_COLORS.map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.82 })
    );
    /** One shared translucent material for camera-occluding buildings. */
    this.fadeMaterial = new THREE.MeshStandardMaterial({
      color: 0xE8ECEE,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      roughness: 0.9,
    });
    /** @type {Set<THREE.Mesh>} Meshes currently rendered transparent. */
    this.faded = new Set();

    /** Max anisotropy for ground textures; main.js sets this from the renderer. */
    this.maxAnisotropy = 4;
    /** @type {Worker[]} Ground rasterizer pool. */
    this.workers = [];
    /** @type {Map<number, string>} In-flight job id → chunk key. */
    this.jobs = new Map();
    this.nextJobId = 0;
    const workerCount = Math.min(2, navigator.hardwareConcurrency || 2);
    for (let k = 0; k < workerCount; k++) {
      const worker = new Worker(new URL('./ground-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => this.onGroundResult(e.data);
      this.workers.push(worker);
    }
  }

  /**
   * Queue high-resolution rasterization of a chunk's ground tile.
   * @param {string} key Chunk key.
   * @param {number} originX Chunk minimum world x.
   * @param {number} originZ Chunk minimum world z.
   */
  requestHiResGround(key, originX, originZ) {
    const id = this.nextJobId++;
    this.jobs.set(id, key);
    this.workers[id % this.workers.length].postMessage({
      id, originX, originZ, size: CHUNK_SIZE, res: GROUND_RES_HI,
    });
  }

  /**
   * Swap a chunk's placeholder ground texture for the worker's hi-res one.
   * @param {{id: number, res: number, buffer: ArrayBuffer}} result Worker output.
   */
  onGroundResult({ id, res, buffer }) {
    const key = this.jobs.get(id);
    this.jobs.delete(id);
    const chunk = key !== undefined ? this.chunks.get(key) : undefined;
    if (!chunk) return; // chunk was unloaded while rasterizing

    const texture = new THREE.DataTexture(new Uint8ClampedArray(buffer), res, res, THREE.RGBAFormat);
    texture.flipY = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.maxAnisotropy;
    texture.needsUpdate = true;

    chunk.texture.dispose();
    chunk.texture = texture;
    chunk.tile.material.map = texture;
    chunk.tile.material.needsUpdate = true;
  }

  /**
   * Install the building geometry pool and (re)generate the world.
   * @param {import('./buildings.js').BuildingTemplate[]} pool Loaded templates.
   * @param {THREE.Vector3} focus Position to generate the first chunks around.
   */
  setPool(pool, focus) {
    this.pool = pool;
    this.planner = createCityPlanner(
      pool.map((t) => ({ w: t.size.x, d: t.size.z, h: t.size.y }))
    );
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    this.faded.clear();
    this.update(focus, Infinity);
  }

  /** @returns {boolean} Whether the building pool is loaded. */
  get ready() {
    return this.pool.length > 0;
  }

  /**
   * Stream chunks around the given position, building at most `budget` new
   * chunks per call (nearest first) to keep frame hitches small.
   * @param {THREE.Vector3} position Drone position.
   * @param {number} [budget] Max chunks to build this call.
   */
  update(position, budget = 2) {
    if (!this.ready) return;
    const ccx = Math.floor(position.x / CHUNK_SIZE);
    const ccz = Math.floor(position.z / CHUNK_SIZE);

    /** @type {{cx: number, cz: number, d: number}[]} */
    const missing = [];
    for (let cx = ccx - VIEW_RADIUS; cx <= ccx + VIEW_RADIUS; cx++) {
      for (let cz = ccz - VIEW_RADIUS; cz <= ccz + VIEW_RADIUS; cz++) {
        if (!this.chunks.has(`${cx},${cz}`)) {
          missing.push({ cx, cz, d: Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) });
        }
      }
    }
    missing.sort((a, b) => a.d - b.d);
    for (const m of missing.slice(0, budget)) {
      this.chunks.set(`${m.cx},${m.cz}`, this.buildChunk(m.cx, m.cz));
    }

    for (const [key, chunk] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > VIEW_RADIUS) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
  }

  /**
   * Deterministically populate one chunk with a ground tile and buildings.
   * @param {number} cx Chunk x coordinate.
   * @param {number} cz Chunk z coordinate.
   */
  buildChunk(cx, cz) {
    const group = new THREE.Group();
    /** @type {{box: THREE.Box3, mesh: THREE.Mesh}[]} */
    const colliders = [];
    const originX = cx * CHUNK_SIZE;
    const originZ = cz * CHUNK_SIZE;

    const { tile, texture } = this.buildGroundTile(originX, originZ);
    group.add(tile);
    this.requestHiResGround(`${cx},${cz}`, originX, originZ);

    for (const p of this.planner.placementsIn(originX, originZ, CHUNK_SIZE, CHUNK_SIZE)) {
      const template = this.pool[p.index];
      const material = this.materials[Math.floor(p.r * this.materials.length)];
      const mesh = new THREE.Mesh(template.geometry, material);
      mesh.rotation.y = p.quarter * (Math.PI / 2);
      mesh.position.set(p.x, 0, p.z);
      group.add(mesh);

      colliders.push({
        box: new THREE.Box3(
          new THREE.Vector3(p.x - p.hw, 0, p.z - p.hd),
          new THREE.Vector3(p.x + p.hw, template.size.y, p.z + p.hd)
        ),
        mesh,
      });
    }

    this.scene.add(group);
    return { group, tile, texture, colliders };
  }

  /**
   * Rasterize the road field into a ground tile, anti-aliasing road edges
   * with the signed distance from sampleCity.
   * @param {number} originX Chunk minimum world x.
   * @param {number} originZ Chunk minimum world z.
   * @returns {{tile: THREE.Mesh, texture: THREE.CanvasTexture}}
   */
  buildGroundTile(originX, originZ) {
    const canvas = document.createElement('canvas');
    canvas.width = GROUND_RES;
    canvas.height = GROUND_RES;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(GROUND_RES, GROUND_RES);
    const metersPerPixel = CHUNK_SIZE / GROUND_RES;

    for (let j = 0; j < GROUND_RES; j++) {
      for (let i = 0; i < GROUND_RES; i++) {
        const wx = originX + ((i + 0.5) / GROUND_RES) * CHUNK_SIZE;
        const wz = originZ + ((j + 0.5) / GROUND_RES) * CHUNK_SIZE;
        const cell = sampleCity(wx, wz);

        let rgb;
        if (cell.plaza) {
          rgb = COL_PLAZA;
        } else {
          // t: 0 on the road, 1 on the block, smooth across one pixel.
          const t = Math.min(1, Math.max(0, cell.edge / metersPerPixel + 0.5));
          const road = cell.major ? COL_MAJOR : COL_MINOR;
          rgb = [
            road[0] + (COL_GROUND[0] - road[0]) * t,
            road[1] + (COL_GROUND[1] - road[1]) * t,
            road[2] + (COL_GROUND[2] - road[2]) * t,
          ];
        }
        const o = (j * GROUND_RES + i) * 4;
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.maxAnisotropy;
    const tile = new THREE.Mesh(
      new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 1 })
    );
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(originX + CHUNK_SIZE / 2, 0, originZ + CHUNK_SIZE / 2);
    return { tile, texture };
  }

  /**
   * Free a chunk's GPU resources and detach it.
   * @param {{group: THREE.Group, tile: THREE.Mesh, texture: THREE.Texture}} chunk Chunk record.
   */
  disposeChunk(chunk) {
    this.scene.remove(chunk.group);
    chunk.texture.dispose();
    chunk.tile.geometry.dispose();
    chunk.tile.material.dispose();
  }

  /**
   * Test a sphere (the drone) against buildings in the chunks around it.
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
        for (const { box } of chunk.colliders) {
          if (box.distanceToPoint(center) < radius) return true;
        }
      }
    }
    return false;
  }

  /**
   * Render buildings near the camera as transparent so they don't block the
   * view, restoring the opaque material once they move away. Pass
   * `active = false` (e.g. in FPV, where the camera sits at the drone and
   * never has a building sitting right in front of the lens) to restore
   * everything to opaque and skip the distance scan.
   * @param {THREE.Vector3} cameraPosition Camera world position.
   * @param {boolean} [active] Whether fading should be applied at all.
   */
  fadeNear(cameraPosition, active = true) {
    const nowFaded = new Set();
    if (!active) {
      for (const mesh of this.faded) mesh.material = mesh.userData.origMat;
      this.faded = nowFaded;
      return;
    }

    const ccx = Math.floor(cameraPosition.x / CHUNK_SIZE);
    const ccz = Math.floor(cameraPosition.z / CHUNK_SIZE);

    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
        const chunk = this.chunks.get(`${cx},${cz}`);
        if (!chunk) continue;
        for (const { box, mesh } of chunk.colliders) {
          if (box.distanceToPoint(cameraPosition) < FADE_DISTANCE) {
            nowFaded.add(mesh);
            if (!this.faded.has(mesh)) {
              mesh.userData.origMat = mesh.material;
              mesh.material = this.fadeMaterial;
            }
          }
        }
      }
    }

    for (const mesh of this.faded) {
      if (!nowFaded.has(mesh)) mesh.material = mesh.userData.origMat;
    }
    this.faded = nowFaded;
  }
}
