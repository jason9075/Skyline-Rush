/**
 * Deterministic procedural city field.
 *
 * Everything here is a pure function of world coordinates (x, z), so the
 * infinite chunked world stays seamless: each chunk merely samples these
 * functions and no cross-chunk state is needed.
 *
 * Streets are Catmull-Rom splines: each grid line's control points sit on a
 * global lattice (every CTRL_INTERVAL meters along the road) with a hashed
 * lateral offset, and the spline interpolates them into a smooth curve.
 * Arterials (major roads) sit on every Nth grid line; the rest are alleys.
 * Roundabouts appear, at low probability, only where two arterials cross.
 *
 * Building placement (createCityPlanner) packs each block with a multi-scale
 * lattice: a large, a medium, and a small pass. Later passes deterministically
 * recompute nearby earlier-pass placements to avoid overlap, so any chunk can
 * be generated independently and still agree with its neighbors.
 */

/** Global seed; changing it reshapes the entire city deterministically. */
const SEED = 0x1a2b3c;

/** Grid spacing between road centerlines (block pitch), meters. */
const SPACING = 56;
/** Every Nth grid line is a wide arterial. */
const MAJOR_EVERY = 3;
/** Half-widths of alley and arterial carriageways, meters. */
const MINOR_HALF = 3.5;
const MAJOR_HALF = 7.5;

/** Spline control-point interval along a road and max lateral offset. */
const CTRL_INTERVAL = 150;
const OFFSET_AMP = 14;

/** Roundabout tuning. */
const ROUNDABOUT_PROB = 0.16;
const RA_OUTER = 24;
const RA_RING = 7;
const RA_ISLAND = RA_OUTER - RA_RING;

/** Hash salts for the two road axes. */
const SALT_V = 7;
const SALT_H = 19;

/**
 * Hash two integers (plus a salt) to a float in [0, 1). No global RNG state.
 * @param {number} ix Integer lattice x.
 * @param {number} iz Integer lattice z.
 * @param {number} [salt] Channel selector.
 * @returns {number}
 */
function hashInt(ix, iz, salt = 0) {
  let h = (Math.imul(ix | 0, 374761393) ^
    Math.imul(iz | 0, 668265263) ^
    Math.imul(salt | 0, 2246822519) ^ SEED) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep. */
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * 2D value noise in [0, 1), bilinearly interpolated over a hashed lattice.
 * @param {number} x Sample x.
 * @param {number} z Sample z.
 * @param {number} [salt] Noise channel.
 * @returns {number}
 */
function valueNoise(x, z, salt = 0) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const v00 = hashInt(x0, z0, salt);
  const v10 = hashInt(x0 + 1, z0, salt);
  const v01 = hashInt(x0, z0 + 1, salt);
  const v11 = hashInt(x0 + 1, z0 + 1, salt);
  const sx = smooth(fx);
  const sz = smooth(fz);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}

/**
 * Uniform Catmull-Rom interpolation of four scalar control values.
 * @param {number} p0 @param {number} p1 @param {number} p2 @param {number} p3
 * @param {number} t Fraction in [0, 1) between p1 and p2.
 * @returns {number}
 */
function catmullRom(p0, p1, p2, p3, t) {
  return 0.5 * (
    2 * p1 +
    (p2 - p0) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (3 * p1 - p0 - 3 * p2 + p3) * t * t * t
  );
}

/**
 * Hashed lateral offset of one spline control point.
 * @param {number} idx Road index.
 * @param {number} k Control point index along the road.
 * @param {number} salt Axis salt.
 * @returns {number}
 */
function ctrlOffset(idx, k, salt) {
  return (hashInt(idx, k, salt) - 0.5) * 2 * OFFSET_AMP;
}

/**
 * Centerline of road `idx` at position `along` its length: the Catmull-Rom
 * spline through its hashed control points.
 * @param {number} idx Road index.
 * @param {number} along Coordinate along the road (z for vertical roads).
 * @param {number} salt Axis salt.
 * @returns {number} Lateral world coordinate of the centerline.
 */
function roadCenter(idx, along, salt) {
  const kf = along / CTRL_INTERVAL;
  const k = Math.floor(kf);
  const t = kf - k;
  return idx * SPACING + catmullRom(
    ctrlOffset(idx, k - 1, salt),
    ctrlOffset(idx, k, salt),
    ctrlOffset(idx, k + 1, salt),
    ctrlOffset(idx, k + 2, salt),
    t
  );
}

/** @param {number} idx @returns {boolean} */
const isMajor = (idx) => ((idx % MAJOR_EVERY) + MAJOR_EVERY) % MAJOR_EVERY === 0;

/**
 * Nearest road of one axis to a sample point.
 * @param {number} coord Lateral coordinate (x for vertical roads).
 * @param {number} along Coordinate along the road.
 * @param {number} salt Axis salt.
 * @returns {{idx: number, center: number, dist: number, half: number, major: boolean}}
 */
function nearestRoad(coord, along, salt) {
  const i0 = Math.round(coord / SPACING);
  let best = null;
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    const center = roadCenter(i, along, salt);
    const dist = Math.abs(coord - center);
    if (!best || dist < best.dist) best = { idx: i, center, dist, major: isMajor(i) };
  }
  best.half = best.major ? MAJOR_HALF : MINOR_HALF;
  return best;
}

/**
 * Resolve which of the two axis roads governs a point. A major road always
 * wins wherever its rectangle overlaps a crossing minor road — otherwise a
 * minor alley cuts a wrong-colored diamond into the arterial it crosses,
 * since the alley's smaller half-width makes its (negative) edge value more
 * extreme than the arterial's a few meters off the arterial's centerline.
 * @param {ReturnType<typeof nearestRoad>} v Nearest vertical-axis road.
 * @param {number} edgeV Signed edge distance to `v` (< 0 inside).
 * @param {ReturnType<typeof nearestRoad>} h Nearest horizontal-axis road.
 * @param {number} edgeH Signed edge distance to `h` (< 0 inside).
 * @returns {{nearer: ReturnType<typeof nearestRoad>, edge: number, major: boolean}}
 */
function resolveRoad(v, edgeV, h, edgeH) {
  const vMajorHit = v.major && edgeV < 0;
  const hMajorHit = h.major && edgeH < 0;
  if (vMajorHit || hMajorHit) {
    if (vMajorHit && hMajorHit) {
      return edgeV <= edgeH
        ? { nearer: v, edge: edgeV, major: true }
        : { nearer: h, edge: edgeH, major: true };
    }
    return vMajorHit ? { nearer: v, edge: edgeV, major: true } : { nearer: h, edge: edgeH, major: true };
  }
  return edgeV <= edgeH
    ? { nearer: v, edge: edgeV, major: v.major }
    : { nearer: h, edge: edgeH, major: h.major };
}

/**
 * Actual crossing point of two arterial splines, found by fixed-point
 * iteration (converges fast because the curves are gentle).
 * @param {number} iM Vertical arterial index.
 * @param {number} jM Horizontal arterial index.
 * @returns {{x: number, z: number}}
 */
function roundaboutCenter(iM, jM) {
  let zc = jM * SPACING;
  let xc = roadCenter(iM, zc, SALT_V);
  zc = roadCenter(jM, xc, SALT_H);
  xc = roadCenter(iM, zc, SALT_V);
  return { x: xc, z: zc };
}

/**
 * @typedef {Object} CitySample
 * @property {boolean} road True on a carriageway (no building).
 * @property {boolean} plaza True on a roundabout island (kept clear).
 * @property {boolean} major True when the nearest road is an arterial.
 * @property {number} clearance Distance to the nearest road edge (0 on roads).
 * @property {number} edge Signed distance to the road edge (< 0 inside a road).
 * @property {[number, number]} front Unit direction toward the nearest road.
 */

/**
 * Classify a world point against the street network.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {CitySample}
 */
export function sampleCity(x, z) {
  const v = nearestRoad(x, z, SALT_V);
  const h = nearestRoad(z, x, SALT_H);
  const { nearer, edge: resolved, major: resolvedMajor } = resolveRoad(
    v, v.dist - v.half, h, h.dist - h.half
  );
  const front = nearer === v
    ? [Math.sign(v.center - x) || 1, 0]
    : [0, Math.sign(h.center - z) || 1];

  let edge = resolved;
  let major = resolvedMajor;

  // Roundabout overrides the straight crossing near an arterial intersection.
  const iM = MAJOR_EVERY * Math.round(x / (SPACING * MAJOR_EVERY));
  const jM = MAJOR_EVERY * Math.round(z / (SPACING * MAJOR_EVERY));
  if (hashInt(iM, jM, 101) < ROUNDABOUT_PROB) {
    const c = roundaboutCenter(iM, jM);
    const rw = Math.hypot(x - c.x, z - c.z);
    if (rw < RA_ISLAND) {
      return { road: false, plaza: true, major: false, clearance: 0, edge: 0, front };
    }
    if (rw < RA_OUTER) {
      const ringEdge = Math.max(rw - RA_OUTER, RA_ISLAND - rw);
      return { road: true, plaza: false, major: true, clearance: 0, edge: ringEdge, front };
    }
    edge = Math.min(edge, rw - RA_OUTER);
    if (edge === rw - RA_OUTER) major = true;
  }

  if (edge < 0) return { road: true, plaza: false, major, clearance: 0, edge, front };
  return { road: false, plaza: false, major, clearance: edge, edge, front };
}

/**
 * Low-frequency downtown/outskirts field for height zoning.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {number} 0 (outskirts) … 1 (downtown).
 */
export function heightZone(x, z) {
  return valueNoise(x / 900 + 3.3, z / 900 + 8.1, 55);
}

/**
 * @typedef {Object} CityDetail
 * @property {number} edge Signed distance to the road edge (< 0 inside a road).
 * @property {boolean} major Nearest road is an arterial.
 * @property {boolean} plaza Inside a roundabout island.
 * @property {number} centerDist Distance to the nearest road centerline.
 * @property {number} along Coordinate along that road (for dashed markings).
 * @property {number} crossEdge Edge distance of the crossing-axis road
 *   (markings are suppressed near intersections where this is small).
 */

/**
 * Detailed road-field sample for ground-texture rasterization. Same network
 * as sampleCity, but also reports centerline metrics for lane markings.
 * On a roundabout ring the "centerline" is the ring's circular lane and
 * `along` is arc length, so dashes follow the circle.
 * @param {number} x World x.
 * @param {number} z World z.
 * @returns {CityDetail}
 */
export function sampleCityDetail(x, z) {
  const v = nearestRoad(x, z, SALT_V);
  const h = nearestRoad(z, x, SALT_H);
  const { nearer, edge: resolved, major: resolvedMajor } = resolveRoad(
    v, v.dist - v.half, h, h.dist - h.half
  );
  const other = nearer === v ? h : v;
  let edge = resolved;
  let major = resolvedMajor;

  const iM = MAJOR_EVERY * Math.round(x / (SPACING * MAJOR_EVERY));
  const jM = MAJOR_EVERY * Math.round(z / (SPACING * MAJOR_EVERY));
  if (hashInt(iM, jM, 101) < ROUNDABOUT_PROB) {
    const c = roundaboutCenter(iM, jM);
    const rw = Math.hypot(x - c.x, z - c.z);
    if (rw < RA_ISLAND) {
      return { edge: 0, major: false, plaza: true, centerDist: Infinity, along: 0, crossEdge: Infinity };
    }
    if (rw < RA_OUTER) {
      const lane = (RA_ISLAND + RA_OUTER) / 2;
      return {
        edge: Math.max(rw - RA_OUTER, RA_ISLAND - rw),
        major: true,
        plaza: false,
        centerDist: Math.abs(rw - lane),
        along: Math.atan2(z - c.z, x - c.x) * lane,
        crossEdge: Infinity,
      };
    }
    if (rw - RA_OUTER < edge) {
      edge = rw - RA_OUTER;
      major = true;
    }
  }

  return {
    edge,
    major,
    plaza: false,
    centerDist: nearer.dist,
    along: nearer === v ? z : x,
    crossEdge: other.dist - other.half,
  };
}

/* ─── Building placement ──────────────────────────────────────────── */

/** Multi-scale placement passes: large blocks first, then infill. */
const PASSES = [
  { pitch: 32, jitter: 2.0, cap: 26.0, salt: 211 },
  { pitch: 17, jitter: 1.5, cap: 12.0, salt: 231 },
  { pitch: 11, jitter: 0.8, cap: 7.8, salt: 251 },
];
/** Minimum gap between two buildings, meters. */
const GAP = 1.6;
/** Minimum clearance from a road for a lot to be buildable, meters. */
const MIN_CLEAR = 2;
/** Setback between a facade and the road edge, meters. */
const SETBACK = 0.6;
/** Chance a lot is deliberately left open (courtyards), per pass. */
const SKIP_CHANCE = 0.08;
/** Radius around the world origin kept free of buildings (spawn plaza). */
const SPAWN_CLEAR_RADIUS = 35;

/**
 * Quarter-turn (0-3) that orients a building toward the nearest road.
 * @param {[number, number]} front Direction toward the road.
 * @returns {number}
 */
function frontQuarter(front) {
  const [fx, fz] = front;
  if (Math.abs(fx) >= Math.abs(fz)) return fx >= 0 ? 1 : 3;
  return fz >= 0 ? 0 : 2;
}

/**
 * @typedef {Object} Placement
 * @property {number} x World x of the building center.
 * @property {number} z World z of the building center.
 * @property {number} hw Half-extent along world x (rotation applied).
 * @property {number} hd Half-extent along world z (rotation applied).
 * @property {number} quarter Quarter-turns around y.
 * @property {number} index Catalogue index of the chosen building.
 * @property {number} r Deterministic random in [0, 1) for cosmetic choices.
 */

/**
 * Create a deterministic building planner for a catalogue of building sizes.
 * @param {{w: number, d: number, h: number}[]} catalogue Building dimensions.
 * @returns {{placementsIn: (minX: number, minZ: number, spanX: number, spanZ: number) => Placement[]}}
 */
export function createCityPlanner(catalogue) {
  /** Catalogue order sorted by footprint (max of w/d), ascending. */
  const order = catalogue
    .map((c, i) => ({ i, foot: Math.max(c.w, c.d), h: c.h }))
    .sort((a, b) => a.foot - b.foot);
  /** @type {Map<string, Placement | null>} */
  const memo = new Map();

  /**
   * Pick a catalogue entry that fits and suits the height zone. Prefers
   * entries that actually use the available footprint (≥ 55% of it).
   * @param {number} maxFoot Largest usable footprint, meters.
   * @param {number} zone Downtown/outskirts value in [0, 1].
   * @param {number} r Deterministic selector in [0, 1).
   * @returns {number} Catalogue index, or -1.
   */
  function pick(maxFoot, zone, r) {
    let hi = 0;
    while (hi < order.length && order[hi].foot <= maxFoot) hi++;
    if (hi === 0) return -1;
    let lo = hi - 1;
    while (lo > 0 && order[lo - 1].foot >= maxFoot * 0.55) lo--;
    const band = order.slice(lo, hi).sort((a, b) => a.h - b.h);
    let start = 0;
    let count = band.length;
    if (zone > 0.62) {
      start = Math.floor(band.length / 2);
      count = band.length - start;
    } else if (zone < 0.35) {
      count = Math.max(1, Math.ceil(band.length / 2));
    }
    const entry = band[start + Math.floor(r * count)] ?? band[band.length - 1];
    return entry.i;
  }

  /**
   * Deterministic placement for one lattice cell of one pass, or null.
   * Later passes call earlier passes for their neighbors, so any cell can be
   * evaluated in isolation and still agree across chunk borders.
   * @param {number} pass Pass index.
   * @param {number} px Cell x index.
   * @param {number} pz Cell z index.
   * @returns {Placement | null}
   */
  function placementAt(pass, px, pz) {
    const key = `${pass},${px},${pz}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    const cfg = PASSES[pass];
    let result = null;
    attempt: {
      if (hashInt(px, pz, cfg.salt) < SKIP_CHANCE) break attempt;
      const x = (px + 0.5) * cfg.pitch + (hashInt(px, pz, cfg.salt + 1) - 0.5) * 2 * cfg.jitter;
      const z = (pz + 0.5) * cfg.pitch + (hashInt(px, pz, cfg.salt + 2) - 0.5) * 2 * cfg.jitter;
      if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS) break attempt;

      const cell = sampleCity(x, z);
      if (cell.road || cell.plaza || cell.clearance < MIN_CLEAR) break attempt;

      const maxFoot = Math.min((cell.clearance - SETBACK) * 2, cfg.cap);
      const index = pick(maxFoot, heightZone(x, z), hashInt(px, pz, cfg.salt + 3));
      if (index < 0) break attempt;

      const c = catalogue[index];
      const quarter = frontQuarter(cell.front);
      let hw = c.w / 2;
      let hd = c.d / 2;
      if (quarter % 2 === 1) [hw, hd] = [hd, hw];

      // Clearance was measured at the center; curved roads can drift closer
      // over the footprint length, so verify all four corners stay off-road.
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          if (sampleCity(x + sx * hw, z + sz * hd).edge < 0.3) break attempt;
        }
      }

      // Reject overlap against earlier-pass placements nearby.
      for (let e = 0; e < pass; e++) {
        const ec = PASSES[e];
        const reach = ec.cap / 2 + ec.jitter + Math.max(hw, hd) + GAP;
        const axMin = Math.floor((x - reach) / ec.pitch);
        const axMax = Math.floor((x + reach) / ec.pitch);
        const azMin = Math.floor((z - reach) / ec.pitch);
        const azMax = Math.floor((z + reach) / ec.pitch);
        for (let ax = axMin; ax <= axMax; ax++) {
          for (let az = azMin; az <= azMax; az++) {
            const p = placementAt(e, ax, az);
            if (p &&
              Math.abs(x - p.x) < hw + p.hw + GAP &&
              Math.abs(z - p.z) < hd + p.hd + GAP) {
              break attempt;
            }
          }
        }
      }

      result = { x, z, hw, hd, quarter, index, r: hashInt(px, pz, cfg.salt + 4) };
    }

    if (memo.size > 60000) memo.clear();
    memo.set(key, result);
    return result;
  }

  /**
   * All building placements whose center lies inside a rectangle.
   * @param {number} minX Rectangle minimum x.
   * @param {number} minZ Rectangle minimum z.
   * @param {number} spanX Rectangle width.
   * @param {number} spanZ Rectangle depth.
   * @returns {Placement[]}
   */
  function placementsIn(minX, minZ, spanX, spanZ) {
    const out = [];
    for (let pass = 0; pass < PASSES.length; pass++) {
      const { pitch } = PASSES[pass];
      const pxMin = Math.floor(minX / pitch) - 1;
      const pxMax = Math.floor((minX + spanX) / pitch) + 1;
      const pzMin = Math.floor(minZ / pitch) - 1;
      const pzMax = Math.floor((minZ + spanZ) / pitch) + 1;
      for (let px = pxMin; px <= pxMax; px++) {
        for (let pz = pzMin; pz <= pzMax; pz++) {
          const p = placementAt(pass, px, pz);
          if (!p) continue;
          if (p.x < minX || p.x >= minX + spanX || p.z < minZ || p.z >= minZ + spanZ) continue;
          out.push(p);
        }
      }
    }
    return out;
  }

  return { placementsIn };
}
