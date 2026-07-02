/**
 * Gate Rush game mode: an endless slalom of square gates threaded along the
 * procedural road network.
 *
 * No general 3D path planner is needed: building placement guarantees a
 * setback from every carriageway, so roads are building-free flight
 * corridors. The course therefore just walks the road splines — advance a
 * random step along the current road, sometimes turn at an intersection,
 * and keep consecutive gates within a bounded altitude delta. Everything is
 * evaluated through citygen's pure functions, so gates can be planned
 * arbitrarily far ahead of chunk streaming.
 *
 * Each gate also records the road polyline the planner walked to reach it,
 * rendered as a Liftoff-style suggested path: faint white wind streaks that
 * glide along the line toward the gate. The polyline follows the roads — a
 * straight line between gates would cut through buildings after a turn.
 */

import * as THREE from 'three';

import { ROADS, roadCenter, isMajor, roundaboutCenter, hasRoundabout } from './citygen.js';

/** Gate aperture half-size (square opening), meters. */
const GATE_HALF = 2.5;
/** Frame bar width and depth, meters. */
const BAR = 0.3;
/** Road distance between consecutive gates, meters. */
const STEP_MIN = 70;
const STEP_MAX = 95;
/** Gate altitude band and max altitude change between gates, meters. */
const Y_MIN = 4;
const Y_MAX = 13;
const DY_MAX = 3;
/** Minimum gate distance from a roundabout center, meters. */
const RA_AVOID = ROADS.RA_OUTER + 12;
/** Guidance beacon (light pillar) height, meters. */
const BEACON_HEIGHT = 70;
/** Spacing of suggested-path samples along the road, meters. */
const PATH_SAMPLE = 6;
const GATE_COLOR = 0xE0301E;

/**
 * Turn probability per crossing-road type. Normal keeps the course on wide
 * arterials; hard prefers ducking into the narrow alleys.
 * @type {Record<'normal' | 'hard', {major: number, minor: number}>}
 */
const TURN_PROB = {
  normal: { major: 0.35, minor: 0 },
  hard: { major: 0.2, minor: 0.55 },
};

/**
 * mulberry32 PRNG: reproducible within one run, independent of the world
 * hashes so course randomness never perturbs city generation.
 * @param {number} seed Uint32 seed.
 * @returns {() => number} Uniform [0, 1) generator.
 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smoothstep. */
const smooth = (t) => t * t * (3 - 2 * t);

/**
 * @typedef {Object} RoadWalker
 * @property {'v' | 'h'} axis Current road axis ('v' runs along z).
 * @property {number} idx Road lattice index.
 * @property {number} along Coordinate along the road (z for 'v', x for 'h').
 * @property {number} dir Travel direction sign along the road.
 * @property {number} y Current gate altitude.
 */

/**
 * World position of a walker on its road centerline.
 * @param {RoadWalker} w Walker.
 * @returns {{x: number, z: number}}
 */
function walkerPos(w) {
  if (w.axis === 'v') return { x: roadCenter(w.idx, w.along, ROADS.SALT_V), z: w.along };
  return { x: w.along, z: roadCenter(w.idx, w.along, ROADS.SALT_H) };
}

/**
 * Unit travel direction (road spline tangent, signed by `dir`).
 * @param {RoadWalker} w Walker.
 * @returns {THREE.Vector3}
 */
function walkerTangent(w) {
  const e = 2;
  if (w.axis === 'v') {
    const dx =
      roadCenter(w.idx, w.along + e, ROADS.SALT_V) - roadCenter(w.idx, w.along - e, ROADS.SALT_V);
    return new THREE.Vector3(dx * w.dir, 0, 2 * e * w.dir).normalize();
  }
  const dz =
    roadCenter(w.idx, w.along + e, ROADS.SALT_H) - roadCenter(w.idx, w.along - e, ROADS.SALT_H);
  return new THREE.Vector3(2 * e * w.dir, 0, dz * w.dir).normalize();
}

/**
 * Actual spline intersection of the walker's road with crossing road `k`
 * (fixed-point iteration, converges fast on these gentle curves).
 * @param {RoadWalker} w Walker.
 * @param {number} k Crossing road index on the other axis.
 * @returns {{x: number, z: number}}
 */
function crossingPoint(w, k) {
  if (w.axis === 'v') {
    let z = k * ROADS.SPACING;
    let x = roadCenter(w.idx, z, ROADS.SALT_V);
    z = roadCenter(k, x, ROADS.SALT_H);
    x = roadCenter(w.idx, z, ROADS.SALT_V);
    return { x, z };
  }
  let x = k * ROADS.SPACING;
  let z = roadCenter(w.idx, x, ROADS.SALT_H);
  x = roadCenter(k, z, ROADS.SALT_V);
  z = roadCenter(w.idx, x, ROADS.SALT_H);
  return { x, z };
}

/**
 * Sample one road's centerline between two along-coordinates, excluding the
 * start point and including the exact end point.
 * @param {'v' | 'h'} axis Road axis.
 * @param {number} idx Road index.
 * @param {number} fromAlong Segment start.
 * @param {number} toAlong Segment end.
 * @returns {{x: number, z: number}[]}
 */
function segmentPoints(axis, idx, fromAlong, toAlong) {
  const pts = [];
  const n = Math.max(1, Math.ceil(Math.abs(toAlong - fromAlong) / PATH_SAMPLE));
  for (let i = 1; i <= n; i++) {
    const a = fromAlong + ((toAlong - fromAlong) * i) / n;
    pts.push(
      axis === 'v'
        ? { x: roadCenter(idx, a, ROADS.SALT_V), z: a }
        : { x: a, z: roadCenter(idx, a, ROADS.SALT_H) }
    );
  }
  return pts;
}

/**
 * Advance the walker one gate-step: maybe turn at the first crossing that
 * wins its dice roll, finish the remaining distance along the (possibly new)
 * road, dodge roundabouts, and step altitude within the allowed band.
 * @param {RoadWalker} w Walker (mutated).
 * @param {() => number} rand Course PRNG.
 * @param {'normal' | 'hard'} difficulty Route style.
 * @param {boolean} [allowTurn] Permit turning at crossings this step.
 * @returns {THREE.Vector3[]} Road polyline walked this step; its last point
 *   is the new gate position.
 */
function advanceWalker(w, rand, difficulty, allowTurn = true) {
  const prob = TURN_PROB[difficulty];
  const step = STEP_MIN + rand() * (STEP_MAX - STEP_MIN);
  // Crossing roads sit near integer multiples of SPACING on the other axis;
  // skip the first few meters so we never turn right on top of the last gate.
  const from = w.along + w.dir * 14;
  const to = w.along + w.dir * step;
  const kMin = Math.ceil(Math.min(from, to) / ROADS.SPACING);
  const kMax = Math.floor(Math.max(from, to) / ROADS.SPACING);

  const start = walkerPos(w);
  const startAlong = w.along;
  /** @type {{x: number, z: number}[]} */
  const flat = [];
  let tailFrom = startAlong;

  let turned = false;
  for (let n = 0; allowTurn && n <= kMax - kMin && !turned; n++) {
    const k = w.dir > 0 ? kMin + n : kMax - n;
    const p = isMajor(k) ? prob.major : prob.minor;
    if (p <= 0 || rand() >= p) continue;
    const [iV, jH] = w.axis === 'v' ? [w.idx, k] : [k, w.idx];
    if (hasRoundabout(iV, jH)) continue; // don't route turns through roundabouts
    const c = crossingPoint(w, k);
    const oldEnd = w.axis === 'v' ? c.z : c.x;
    flat.push(...segmentPoints(w.axis, w.idx, startAlong, oldEnd));
    const travelled = Math.abs(oldEnd - startAlong);
    w.axis = w.axis === 'v' ? 'h' : 'v';
    w.idx = k;
    w.along = w.axis === 'h' ? c.x : c.z;
    w.dir = rand() < 0.5 ? -1 : 1;
    tailFrom = w.along;
    w.along += w.dir * Math.max(step - travelled, 35);
    turned = true;
  }
  if (!turned) w.along = to;

  // Nudge past any roundabout the gate would otherwise sit inside.
  for (let tries = 0; tries < 5; tries++) {
    const { x, z } = walkerPos(w);
    const iM = ROADS.MAJOR_EVERY * Math.round(x / (ROADS.SPACING * ROADS.MAJOR_EVERY));
    const jM = ROADS.MAJOR_EVERY * Math.round(z / (ROADS.SPACING * ROADS.MAJOR_EVERY));
    if (!hasRoundabout(iM, jM)) break;
    const c = roundaboutCenter(iM, jM);
    if (Math.hypot(x - c.x, z - c.z) >= RA_AVOID) break;
    w.along += w.dir * 25;
  }

  flat.push(...segmentPoints(w.axis, w.idx, tailFrom, w.along));

  // Ease altitude from the previous gate's height to the new one along the
  // walked distance, so the guide line climbs/descends smoothly.
  const prevY = w.y;
  w.y = Math.min(Y_MAX, Math.max(Y_MIN, prevY + (rand() * 2 - 1) * DY_MAX));
  const cum = [];
  let total = 0;
  let px = start.x;
  let pz = start.z;
  for (const pt of flat) {
    total += Math.hypot(pt.x - px, pt.z - pz);
    cum.push(total);
    px = pt.x;
    pz = pt.z;
  }
  return flat.map(
    (pt, i) => new THREE.Vector3(pt.x, prevY + (w.y - prevY) * smooth(cum[i] / total), pt.z)
  );
}

/**
 * Square frame geometry: an extruded square ring, aperture GATE_HALF.
 * @returns {THREE.ExtrudeGeometry}
 */
function buildFrameGeometry() {
  const outer = GATE_HALF + BAR;
  const shape = new THREE.Shape()
    .moveTo(-outer, -outer)
    .lineTo(outer, -outer)
    .lineTo(outer, outer)
    .lineTo(-outer, outer);
  const hole = new THREE.Path()
    .moveTo(-GATE_HALF, -GATE_HALF)
    .lineTo(GATE_HALF, -GATE_HALF)
    .lineTo(GATE_HALF, GATE_HALF)
    .lineTo(-GATE_HALF, GATE_HALF);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: BAR, bevelEnabled: false });
  geo.translate(0, 0, -BAR / 2);
  return geo;
}

/**
 * Wind-streak guide-line shader. `lineDistance` (from computeLineDistances)
 * parameterizes the polyline in meters; the fragment stage draws comet-like
 * white pulses whose phase advances with time, so they glide along the path
 * toward the gate. A faint constant base keeps the route readable between
 * pulses without being showy.
 */
const WIND_VERT = /* glsl */ `
  attribute float lineDistance;
  varying float vDist;
  void main() {
    vDist = lineDistance;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const WIND_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  varying float vDist;
  void main() {
    float p = fract((vDist - uTime * 14.0) / 34.0);
    float streak = pow(p, 3.0);
    gl_FragColor = vec4(vec3(1.0), uOpacity * (0.08 + 0.92 * streak));
  }
`;

/**
 * @param {number} opacity Peak streak opacity.
 * @returns {THREE.ShaderMaterial}
 */
function makeWindMaterial(opacity) {
  return new THREE.ShaderMaterial({
    vertexShader: WIND_VERT,
    fragmentShader: WIND_FRAG,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: opacity } },
    transparent: true,
    depthWrite: false,
  });
}

const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();

/** An endless run of gates: planning, rendering, and pass detection. */
export class GateCourse {
  /**
   * @param {THREE.Scene} scene Scene to add course objects to.
   * @param {'normal' | 'hard'} difficulty Route style.
   * @param {THREE.Vector3} startPos Drone position at course start.
   * @param {THREE.Vector3} forward Drone facing direction (horizontal).
   */
  constructor(scene, difficulty, startPos, forward) {
    this.scene = scene;
    this.difficulty = difficulty;
    this.rand = mulberry32((Math.random() * 4294967296) >>> 0);
    /** Gates passed this run. */
    this.score = 0;
    this.lastPos = startPos.clone();

    this.frameGeo = buildFrameGeometry();
    this.solidMat = new THREE.MeshBasicMaterial({ color: GATE_COLOR });
    this.ghostMat = new THREE.MeshBasicMaterial({
      color: GATE_COLOR,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.pathSolidMat = makeWindMaterial(0.55);
    this.pathGhostMat = makeWindMaterial(0.22);
    /** Elapsed course time driving the wind-streak animation. */
    this.time = 0;
    this.beaconGeo = new THREE.CylinderGeometry(0.9, 0.9, BEACON_HEIGHT, 12, 1, true);
    this.beaconMat = new THREE.MeshBasicMaterial({
      color: GATE_COLOR,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.beacon = new THREE.Mesh(this.beaconGeo, this.beaconMat);
    scene.add(this.beacon);

    // Start on the nearest lattice road whose axis best matches the drone's
    // facing, heading the same way, so the first gate lands out in front.
    const alongZ = Math.abs(forward.z) >= Math.abs(forward.x);
    /** @type {RoadWalker} */
    this.walker = alongZ
      ? {
          axis: 'v',
          idx: Math.round(startPos.x / ROADS.SPACING),
          along: startPos.z,
          dir: Math.sign(forward.z) || -1,
          y: 6,
        }
      : {
          axis: 'h',
          idx: Math.round(startPos.z / ROADS.SPACING),
          along: startPos.x,
          dir: Math.sign(forward.x) || 1,
          y: 6,
        };
    /** The tail end of the previous guide line; the next one starts there. */
    this.prevAnchor = startPos.clone();
    /** @type {{pos: THREE.Vector3, normal: THREE.Vector3, mesh: THREE.Mesh, line: THREE.Line | null}[]} */
    this.gates = [this.spawnGate(true), this.spawnGate()];
    this.promote();
  }

  /**
   * Plan the next gate, its guide line, and add both (ghosted) to the scene.
   * The opening gate skips both the turn dice and the guide line: it must sit
   * straight ahead of the drone, and the takeoff run needs no wind hint.
   * @param {boolean} [first] This is the course's opening gate.
   */
  spawnGate(first = false) {
    const path = advanceWalker(this.walker, this.rand, this.difficulty, !first);
    const pos = path[path.length - 1].clone();
    const normal = walkerTangent(this.walker);

    const mesh = new THREE.Mesh(this.frameGeo, this.ghostMat);
    mesh.position.copy(pos);
    mesh.lookAt(TMP_A.copy(pos).add(normal));
    this.scene.add(mesh);

    let line = null;
    if (!first) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints([this.prevAnchor.clone(), ...path]);
      line = new THREE.Line(lineGeo, this.pathGhostMat);
      line.computeLineDistances();
      this.scene.add(line);
    }
    this.prevAnchor.copy(pos);

    return { pos, normal, mesh, line };
  }

  /** Highlight the active gate and its guide line; park the beacon above it. */
  promote() {
    const g = this.gates[0];
    g.mesh.material = this.solidMat;
    if (g.line) g.line.material = this.pathSolidMat;
    // The beacon rests on the frame's top edge so it never pokes into the
    // aperture the player is aiming for.
    this.beacon.position.set(g.pos.x, g.pos.y + GATE_HALF + BAR + BEACON_HEIGHT / 2, g.pos.z);
  }

  /** @returns {THREE.Vector3} Center of the gate to fly through next. */
  get target() {
    return this.gates[0].pos;
  }

  /**
   * Advance the wind-streak animation and run pass detection: did the
   * segment lastPos→dronePos cross the active gate's plane, front-to-back,
   * inside the aperture? Segment-based so a fast drone can't tunnel through
   * the plane between frames.
   * @param {THREE.Vector3} dronePos Current drone position.
   * @param {number} dt Frame delta time in seconds.
   * @returns {boolean} True when a gate was passed this frame.
   */
  update(dronePos, dt) {
    this.time += dt;
    this.pathSolidMat.uniforms.uTime.value = this.time;
    this.pathGhostMat.uniforms.uTime.value = this.time;

    const g = this.gates[0];
    const d0 = TMP_A.copy(this.lastPos).sub(g.pos).dot(g.normal);
    const d1 = TMP_A.copy(dronePos).sub(g.pos).dot(g.normal);
    let passed = false;
    if (d0 < 0 && d1 >= 0) {
      const t = d0 / (d0 - d1);
      const hit = TMP_A.copy(this.lastPos).lerp(dronePos, t).sub(g.pos);
      const u = TMP_B.set(-g.normal.z, 0, g.normal.x).dot(hit); // across the gate
      if (Math.abs(u) <= GATE_HALF && Math.abs(hit.y) <= GATE_HALF) {
        passed = true;
        this.score += 1;
        this.scene.remove(g.mesh);
        if (g.line) {
          this.scene.remove(g.line);
          g.line.geometry.dispose();
        }
        this.gates.shift();
        this.gates.push(this.spawnGate());
        this.promote();
      }
    }
    this.lastPos.copy(dronePos);
    return passed;
  }

  /** Remove all course objects from the scene and free GPU resources. */
  dispose() {
    for (const g of this.gates) {
      this.scene.remove(g.mesh);
      if (g.line) {
        this.scene.remove(g.line);
        g.line.geometry.dispose();
      }
    }
    this.scene.remove(this.beacon);
    this.frameGeo.dispose();
    this.beaconGeo.dispose();
    this.solidMat.dispose();
    this.ghostMat.dispose();
    this.pathSolidMat.dispose();
    this.pathGhostMat.dispose();
    this.beaconMat.dispose();
  }
}
