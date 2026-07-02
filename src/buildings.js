/**
 * Building asset loader.
 *
 * The GLBs under assets/buildings/ are raw geometry — no materials, textures,
 * or Draco compression — at real-world scale (footprints ~6-120 m, heights
 * ~4-66 m). We load a deterministic subset, bake each into a single centered
 * BufferGeometry (footprint centered on the origin, base at y = 0), and let
 * the world assign shared palette materials at placement time.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Vite bundles every GLB and hands back its emitted URL. */
const glbModules = import.meta.glob('../assets/buildings/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** Reject footprints larger than this so buildings fit the street grid, meters. */
const MAX_FOOTPRINT = 34;

/**
 * @typedef {Object} BuildingTemplate
 * @property {THREE.BufferGeometry} geometry Centered geometry, base at y = 0.
 * @property {THREE.Vector3} size Bounding-box size (width, height, depth).
 */

/**
 * Load one GLB into a centered template.
 * @param {GLTFLoader} loader Shared loader instance.
 * @param {string} url Asset URL.
 * @returns {Promise<BuildingTemplate | null>} Null on failure or empty scene.
 */
function loadTemplate(loader, url) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        // A glTF mesh with multiple primitives becomes several Mesh nodes;
        // collect them all so we don't drop walls/roofs.
        /** @type {THREE.BufferGeometry[]} */
        const parts = [];
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          // Keep only position + normal so the parts merge cleanly.
          for (const name of Object.keys(g.attributes)) {
            if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
          }
          if (!g.attributes.normal) g.computeVertexNormals();
          parts.push(g);
        });
        if (parts.length === 0) return resolve(null);

        const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
        if (!geometry) return resolve(null);
        geometry.computeBoundingBox();

        const box = geometry.boundingBox;
        const size = new THREE.Vector3();
        box.getSize(size);
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        // Re-origin: footprint centered on (0, z=0), base sitting on y = 0.
        geometry.translate(-cx, -box.min.y, -cz);

        resolve({ geometry, size });
      },
      undefined,
      () => resolve(null)
    );
  });
}

/**
 * Load a spread-out subset of the building catalogue.
 * @param {number} [count] How many GLBs to fetch (before footprint filtering).
 * @returns {Promise<BuildingTemplate[]>} Usable templates.
 */
export async function loadBuildingPool(count = 56) {
  const urls = Object.keys(glbModules)
    .sort()
    .map((key) => glbModules[key]);
  const step = Math.max(1, Math.floor(urls.length / count));
  const chosen = [];
  for (let i = 0; i < urls.length && chosen.length < count; i += step) {
    chosen.push(urls[i]);
  }

  const loader = new GLTFLoader();
  const templates = await Promise.all(chosen.map((url) => loadTemplate(loader, url)));
  return templates.filter(
    (t) => t && Math.max(t.size.x, t.size.z) <= MAX_FOOTPRINT
  );
}
