/**
 * Strike (Bombing Run) game mode: a small enemy force — one machine-gun tank
 * and a handful of shotgun soldiers — spawns on the open road network ahead of
 * the drone. The player has no forward weapon; the only offense is gravity
 * bombs, one of which regenerates every few seconds and is released with the
 * drop key. Each bomb has a tight blast radius (~2 m diameter): soldiers die in
 * one, the tank takes three.
 *
 * Enemies begin dormant. Detection needs three things at once — the drone
 * inside the shooter's range, an unobstructed line of sight (buildings are the
 * only occluders; see {@link World#lineOfSightClear}), and the drone within the
 * shooter's forward vision cone. A dormant shooter faces a fixed heading, so
 * approaching from behind buys time; a bomb blast swings nearby dormant heads
 * toward the explosion, which is how the player can bait aggro. Once engaged, a
 * shooter locks an aim point that tracks the drone with deliberate lag and then
 * fires: sit still and the shot lands, keep moving and it trails behind. Losing
 * sight of the drone for {@link LOSE_TIMEOUT} seconds drops the shooter back to
 * standby.
 *
 * The mission ends when every enemy is destroyed (win) or the drone's health
 * reaches zero (down). A crash into the city is handled by the caller and, like
 * a shoot-down, simply tallies the kills scored so far.
 */

import * as THREE from 'three';

import { sampleCity } from './citygen.js';

/* ─── Tunables ────────────────────────────────────────────────────────── */
/** Drone health; each pellet/round that connects removes one. */
export const DRONE_HP = 10;
/** Bomb blast radius, meters (≈4 m diameter). */
const BLAST_RADIUS = 2.0;
/** Seconds between free bombs, and the most the drone can stockpile. */
const BOMB_REGEN = 5;
/** Most bombs the drone can stockpile (and the number of HUD slots). */
export const BOMB_MAX = 3;
/** Bomb muzzle velocity is inherited from the drone; this is just gravity. */
const BOMB_GRAVITY = 9.81;
/** How many bomb hits each enemy type absorbs. */
const HP_SOLDIER = 1;
const HP_TANK = 3;
/** Soldiers spawned per mission (inclusive range). */
const SOLDIER_MIN = 4;
const SOLDIER_MAX = 6;
/** Distance ahead of the drone to drop the enemy encampment, meters. */
const SPAWN_AHEAD = 60;
/** Soldiers scatter within this radius of the tank, meters. */
const CAMP_RADIUS = 13;
/** Seconds without line of sight before an engaged shooter stands down. */
const LOSE_TIMEOUT = 30;
/** A blast within this radius of a dormant shooter turns its head toward it. */
const ALERT_RADIUS = 42;
/** Half-angle of a shooter's forward vision cone for acquiring a target, rad. */
const VISION_HALF_ANGLE = 1.3;
/** How fast a shooter yaws toward what it's looking at, rad/s. */
const TURN_RATE = 1.6;
/** A bullet passing within this of the drone counts as a hit, m. */
const BULLET_HIT_RADIUS = 1.3;

/**
 * Per-weapon profile. `trackRate` is the aim-point lerp rate toward the drone
 * (lower = laggier = easier to dodge); `roundInterval` spaces the rounds of a
 * burst so sustained fire keeps punishing a stationary drone. Rounds are fired
 * as real projectiles aimed at the (laggy) aim point — a moving drone dodges
 * both the lead error and the bullet's travel time.
 * @typedef {Object} Weapon
 * @property {number} range  Max engagement distance, m.
 * @property {number} aimTime  Telegraph before the first round, s.
 * @property {number} cooldown  Rest between bursts, s.
 * @property {number} burst  Rounds per burst.
 * @property {number} roundInterval  Delay between rounds of a burst, s.
 * @property {number} pellets  Projectiles launched per round.
 * @property {number} spread  Random angular deviation per projectile, rad.
 * @property {number} bulletSpeed  Projectile speed, m/s.
 * @property {number} dmg  Health removed per connecting projectile.
 * @property {number} trackRate  Aim tracking rate, 1/s.
 */

/** Shotgun soldier: short range, a single slow-tracking spread blast. @type {Weapon} */
const SHOTGUN = {
  range: 30, aimTime: 1.5, cooldown: 2.2, burst: 1, roundInterval: 0,
  pellets: 5, spread: 0.09, bulletSpeed: 28, dmg: 1, trackRate: 1.4,
};
/** Tank machine gun: longer reach, a tighter 5-round burst that tracks better. @type {Weapon} */
const MACHINE_GUN = {
  range: 45, aimTime: 1.2, cooldown: 3.6, burst: 5, roundInterval: 0.13,
  pellets: 1, spread: 0.02, bulletSpeed: 40, dmg: 1, trackRate: 2.6,
};

const ENEMY_RED = 0xE0301E;
const LASER_RED = 0xFF2A18;

/* ─── Meshes ──────────────────────────────────────────────────────────── */
/**
 * Low-poly foot soldier facing +Z, gun forward. Origin at the feet so the
 * group can be dropped straight onto the ground (y = 0).
 * @returns {THREE.Group}
 */
function buildSoldier() {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({ color: 0x4C5340, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xC8A57A, roughness: 0.8 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x1B1E20, roughness: 0.5, metalness: 0.6 });

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.9, 0.32), cloth);
  legs.position.y = 0.45;
  g.add(legs);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.34), cloth);
  torso.position.y = 1.2;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skin);
  head.position.y = 1.72;
  g.add(head);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.7), gunMat);
  gun.position.set(0.22, 1.25, 0.35);
  g.add(gun);

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/**
 * Low-poly tank facing +Z with a turret-top machine gunner. Origin at the
 * ground contact so it drops onto y = 0.
 * @returns {THREE.Group}
 */
function buildTank() {
  const g = new THREE.Group();
  const olive = new THREE.MeshStandardMaterial({ color: 0x5A5F3A, roughness: 0.85, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24261C, roughness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2B2E30, roughness: 0.4, metalness: 0.7 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.3, 6.4), olive);
  hull.position.y = 1.1;
  g.add(hull);
  for (const side of [-1, 1]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 6.6), dark);
    track.position.set(side * 1.75, 0.45, 0);
    g.add(track);
  }
  const turret = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 2.8), olive);
  turret.position.set(0, 2.1, -0.4);
  g.add(turret);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 3.6, 12), steel);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 2.2, 1.8);
  g.add(barrel);

  // Exposed machine gunner riding the turret roof — the tank's shooter.
  const gunner = buildSoldier();
  gunner.scale.setScalar(0.9);
  gunner.position.set(0, 2.6, -0.6);
  g.add(gunner);
  const mg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 1.0), steel);
  mg.position.set(0.3, 3.85, 0.2);
  g.add(mg);

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/** mulberry32 PRNG; one instance per mission so encampments vary between runs. */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();

/**
 * Squared distance from point `p` to segment `a`→`b`. Used to sweep-test a
 * projectile's per-frame motion against the drone so fast bullets don't tunnel.
 * @param {THREE.Vector3} a  Segment start.
 * @param {THREE.Vector3} b  Segment end.
 * @param {THREE.Vector3} p  Query point.
 * @returns {number}
 */
function distSqSegPoint(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz || 1;
  let t = (apx * abx + apy * aby + apz * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * @typedef {Object} Enemy
 * @property {'soldier' | 'tank'} type
 * @property {THREE.Group} mesh
 * @property {number} hp  Bomb hits remaining.
 * @property {number} bodyRadius  Kill radius added to the blast radius, m.
 * @property {number} eyeY  Muzzle/eye height above the group origin, m.
 * @property {Weapon} weapon
 * @property {'idle' | 'aiming' | 'firing' | 'cooldown'} state
 * @property {THREE.Vector3} aimPoint  Where the shooter's laser is pointed.
 * @property {THREE.Vector3} facing  Unit XZ heading the shooter looks along.
 * @property {THREE.Vector3} lookAt  Target the facing yaws toward.
 * @property {number} lastSeen  Mission time the drone was last visible, s.
 * @property {number} timer  Aim/cooldown countdown, s.
 * @property {number} roundTimer  Burst inter-round countdown, s.
 * @property {number} roundsLeft  Rounds remaining in the current burst.
 * @property {THREE.Line} laser  Red aim-sight line.
 */

/** A Strike mission: enemy force, bombs, drone health, and win/lose state. */
export class StrikeMission {
  /**
   * @param {THREE.Scene} scene  Scene to populate.
   * @param {import('./world.js').World} world  For line-of-sight tests.
   * @param {THREE.Vector3} startPos  Drone position at mission start.
   * @param {THREE.Vector3} forward  Drone horizontal facing.
   */
  constructor(scene, world, startPos, forward) {
    this.scene = scene;
    this.world = world;
    this.rand = mulberry32((Math.random() * 4294967296) >>> 0);
    this.time = 0;

    this.droneHp = DRONE_HP;
    this.bombStock = 1;
    this.regenTimer = 0;
    /** @type {'active' | 'won' | 'lost'} */
    this.status = 'active';

    /** @type {{pos: THREE.Vector3, vel: THREE.Vector3, mesh: THREE.Mesh}[]} */
    this.bombs = [];
    /** @type {{mesh: THREE.Mesh, life: number, max: number}[]} */
    this.blasts = [];
    /** In-flight enemy projectiles. @type {{pos: THREE.Vector3, prev: THREE.Vector3, vel: THREE.Vector3, mesh: THREE.Mesh, life: number, dmg: number}[]} */
    this.bullets = [];

    // Shared materials/geometry, disposed on teardown.
    this.laserMat = new THREE.LineBasicMaterial({ color: LASER_RED, transparent: true, opacity: 0.85 });
    this.bulletGeo = new THREE.SphereGeometry(0.1, 8, 6);
    this.bulletMat = new THREE.MeshBasicMaterial({
      color: 0xFFC12E, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.bombGeo = new THREE.SphereGeometry(0.16, 10, 8);
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x17191B, roughness: 0.4, metalness: 0.3 });
    this.blastGeo = new THREE.SphereGeometry(1, 16, 12);
    this.blastMat = new THREE.MeshBasicMaterial({
      color: ENEMY_RED, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    /** @type {Enemy[]} */
    this.enemies = [];
    this.total = 0;
    this.spawnForce(startPos, forward);
  }

  /* ─── Setup ───────────────────────────────────────────────────────── */
  /**
   * Drop the encampment on an open patch of road ahead of the drone: the tank
   * at the anchor, soldiers scattered around it. Each unit is nudged until it
   * sits on a building-free spot (roads and their shoulders are clear).
   * @param {THREE.Vector3} startPos  Drone start.
   * @param {THREE.Vector3} forward  Drone facing (horizontal).
   */
  spawnForce(startPos, forward) {
    const dir = TMP.copy(forward).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const anchor = new THREE.Vector3(
      startPos.x + dir.x * SPAWN_AHEAD, 0, startPos.z + dir.z * SPAWN_AHEAD
    );
    const clear = this.findClear(anchor.x, anchor.z, 30) || { x: anchor.x, z: anchor.z };

    this.addEnemy('tank', clear.x, clear.z, startPos);

    const soldiers = SOLDIER_MIN + Math.floor(this.rand() * (SOLDIER_MAX - SOLDIER_MIN + 1));
    for (let i = 0; i < soldiers; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = 5 + this.rand() * (CAMP_RADIUS - 5);
      const px = clear.x + Math.cos(a) * r;
      const pz = clear.z + Math.sin(a) * r;
      const spot = this.findClear(px, pz, 8) || { x: px, z: pz };
      this.addEnemy('soldier', spot.x, spot.z, startPos);
    }
    this.total = this.enemies.length;
  }

  /**
   * Spiral out from (x, z) for the nearest point on a carriageway (guaranteed
   * building-free), so units never spawn inside a wall.
   * @param {number} x
   * @param {number} z
   * @param {number} maxR  Search radius, m.
   * @returns {{x: number, z: number} | null}
   */
  findClear(x, z, maxR) {
    if (sampleCity(x, z).road) return { x, z };
    for (let r = 4; r <= maxR; r += 4) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const cx = x + Math.cos(a) * r;
        const cz = z + Math.sin(a) * r;
        if (sampleCity(cx, cz).road) return { x: cx, z: cz };
      }
    }
    return null;
  }

  /**
   * Instantiate one enemy, add it to the scene, and wire its aim laser.
   * @param {'soldier' | 'tank'} type
   * @param {number} x
   * @param {number} z
   * @param {THREE.Vector3} lookFrom  Face the front line toward the drone start.
   */
  addEnemy(type, x, z, lookFrom) {
    const isTank = type === 'tank';
    const mesh = isTank ? buildTank() : buildSoldier();
    mesh.position.set(x, 0, z);
    this.scene.add(mesh);

    const facing = new THREE.Vector3(lookFrom.x - x, 0, lookFrom.z - z);
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
    facing.normalize();
    mesh.rotation.y = Math.atan2(facing.x, facing.z);

    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const laser = new THREE.Line(geo, this.laserMat);
    laser.visible = false;
    laser.frustumCulled = false;
    this.scene.add(laser);

    /** @type {Enemy} */
    const e = {
      type,
      mesh,
      hp: isTank ? HP_TANK : HP_SOLDIER,
      bodyRadius: isTank ? 2.6 : 0.6,
      eyeY: isTank ? 3.85 : 1.55,
      weapon: isTank ? MACHINE_GUN : SHOTGUN,
      state: 'idle',
      aimPoint: new THREE.Vector3(),
      facing,
      lookAt: facing.clone(),
      lastSeen: -Infinity,
      timer: 0,
      roundTimer: 0,
      roundsLeft: 0,
      laser,
    };
    this.enemies.push(e);
  }

  /* ─── Bombs ───────────────────────────────────────────────────────── */
  /**
   * Release one stocked bomb, inheriting the drone's velocity.
   * @param {THREE.Vector3} pos  Drone position.
   * @param {THREE.Vector3} vel  Drone velocity.
   * @returns {boolean} True if a bomb was dropped (stock was available).
   */
  dropBomb(pos, vel) {
    if (this.bombStock <= 0 || this.status !== 'active') return false;
    this.bombStock -= 1;
    const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.bombs.push({ pos: pos.clone(), vel: vel.clone(), mesh });
    return true;
  }

  /**
   * Detonate at `at`: expanding flash, area damage to every enemy whose body is
   * inside the blast, and an aggro pull on dormant shooters nearby.
   * @param {THREE.Vector3} at  Explosion center.
   */
  explode(at) {
    const mesh = new THREE.Mesh(this.blastGeo, this.blastMat.clone());
    mesh.position.copy(at);
    mesh.scale.setScalar(0.1);
    this.scene.add(mesh);
    this.blasts.push({ mesh, life: 0.45, max: 0.45 });

    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const d = e.mesh.position.distanceTo(at);
      if (d <= BLAST_RADIUS + e.bodyRadius) {
        e.hp -= 1;
        if (e.hp <= 0) this.killEnemy(e);
      } else if (e.state === 'idle' && d <= ALERT_RADIUS) {
        // The blast draws a dormant shooter's attention toward it.
        e.lookAt.set(at.x - e.mesh.position.x, 0, at.z - e.mesh.position.z).normalize();
      }
    }
  }

  /** Remove a destroyed enemy's mesh and laser from the scene. */
  killEnemy(e) {
    this.scene.remove(e.mesh);
    this.scene.remove(e.laser);
    e.laser.geometry.dispose();
    e.laser.visible = false;
  }

  /* ─── AI ──────────────────────────────────────────────────────────── */
  /**
   * Advance one shooter. Returns the health damage it deals the drone this
   * frame (0 unless a round connected).
   * @param {Enemy} e
   * @param {THREE.Vector3} dronePos
   * @param {number} dt
   * @returns {number}
   */
  updateEnemy(e, dronePos, dt) {
    // Yaw the model toward whatever it's currently looking at.
    const targetYaw = Math.atan2(e.lookAt.x, e.lookAt.z);
    let dyaw = targetYaw - Math.atan2(e.facing.x, e.facing.z);
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, dyaw));
    const yaw = Math.atan2(e.facing.x, e.facing.z) + turn;
    e.facing.set(Math.sin(yaw), 0, Math.cos(yaw));
    e.mesh.rotation.y = yaw;

    const eye = TMP.copy(e.mesh.position).setY(e.eyeY);
    const toDrone = TMP2.copy(dronePos).sub(eye);
    const dist = toDrone.length();
    const inRange = dist <= e.weapon.range;
    const los = inRange && this.world.lineOfSightClear(eye, dronePos);
    // Dormant shooters must also have the drone within their vision cone;
    // engaged shooters keep tracking regardless of facing.
    const flatAngle = Math.atan2(toDrone.x, toDrone.z);
    let cone = Math.abs(Math.atan2(Math.sin(flatAngle - yaw), Math.cos(flatAngle - yaw)));
    const detects = los && (e.state !== 'idle' || cone <= VISION_HALF_ANGLE);
    if (detects) e.lastSeen = this.time;

    // Stand down after losing the target for LOSE_TIMEOUT.
    if (e.state !== 'idle' && !los && this.time - e.lastSeen > LOSE_TIMEOUT) {
      e.state = 'idle';
      e.laser.visible = false;
      e.lookAt.copy(e.facing);
      return;
    }

    switch (e.state) {
      case 'idle':
        if (detects) this.beginAim(e, dronePos);
        break;

      case 'aiming':
        if (los) { this.trackAim(e, dronePos, dt); e.lookAt.set(toDrone.x, 0, toDrone.z).normalize(); }
        this.drawLaser(e, eye);
        e.timer -= dt;
        if (e.timer <= 0) {
          e.state = 'firing';
          e.roundsLeft = e.weapon.burst;
          e.roundTimer = 0;
        }
        break;

      case 'firing':
        if (los) { this.trackAim(e, dronePos, dt); e.lookAt.set(toDrone.x, 0, toDrone.z).normalize(); }
        this.drawLaser(e, eye);
        e.roundTimer -= dt;
        if (e.roundTimer <= 0 && e.roundsLeft > 0) {
          e.roundTimer = e.weapon.roundInterval;
          e.roundsLeft -= 1;
          this.fireRound(e, eye);
        }
        if (e.roundsLeft <= 0) {
          e.state = 'cooldown';
          e.timer = e.weapon.cooldown;
          e.laser.visible = false;
        }
        break;

      case 'cooldown':
        e.timer -= dt;
        if (e.timer <= 0) {
          if (detects) this.beginAim(e, dronePos);
          else e.timer = 0.4; // re-check periodically until reacquire or stand-down
        }
        break;
    }
  }

  /** Start a fresh aim, locking the initial aim point on the drone. */
  beginAim(e, dronePos) {
    e.state = 'aiming';
    e.timer = e.weapon.aimTime;
    e.aimPoint.copy(dronePos);
    e.laser.visible = true;
  }

  /** Ease the aim point toward the drone; the lag is what a mover exploits. */
  trackAim(e, dronePos, dt) {
    e.aimPoint.lerp(dronePos, Math.min(1, e.weapon.trackRate * dt));
  }

  /** Point the aim laser from the muzzle to the current aim point. */
  drawLaser(e, eye) {
    const pos = e.laser.geometry.attributes.position;
    pos.setXYZ(0, eye.x, eye.y, eye.z);
    pos.setXYZ(1, e.aimPoint.x, e.aimPoint.y, e.aimPoint.z);
    pos.needsUpdate = true;
  }

  /**
   * Fire one round from the muzzle toward the current (laggy) aim point: launch
   * `pellets` real projectiles, each nudged by a random spread. Whether they
   * connect is decided later, as they fly, in {@link StrikeMission#updateBullets}.
   * @param {Enemy} e
   * @param {THREE.Vector3} eye  Muzzle position.
   */
  fireRound(e, eye) {
    const w = e.weapon;
    const base = TMP2.copy(e.aimPoint).sub(eye);
    if (base.lengthSq() < 1e-6) return;
    base.normalize();
    for (let p = 0; p < w.pellets; p++) {
      const dir = base.clone();
      dir.x += (this.rand() * 2 - 1) * w.spread;
      dir.y += (this.rand() * 2 - 1) * w.spread;
      dir.z += (this.rand() * 2 - 1) * w.spread;
      dir.normalize();
      const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
      mesh.position.copy(eye);
      this.scene.add(mesh);
      this.bullets.push({
        pos: eye.clone(),
        prev: eye.clone(),
        vel: dir.multiplyScalar(w.bulletSpeed),
        mesh,
        life: w.range / w.bulletSpeed + 0.4,
        dmg: w.dmg,
      });
    }
  }

  /* ─── Frame ───────────────────────────────────────────────────────── */
  /**
   * Step bombs, enemies, projectiles, and effects one frame.
   * @param {THREE.Vector3} dronePos  Current drone position.
   * @param {number} dt  Frame delta, s.
   * @param {boolean} [invulnerable]  God mode: projectiles pass through the
   *   drone harmlessly (they still fly and are visible).
   * @returns {{damage: number}} Health lost by the drone this frame.
   */
  update(dronePos, dt, invulnerable = false) {
    this.time += dt;

    // Bomb stock regen.
    if (this.bombStock < BOMB_MAX) {
      this.regenTimer += dt;
      if (this.regenTimer >= BOMB_REGEN) { this.bombStock += 1; this.regenTimer = 0; }
    } else {
      this.regenTimer = 0;
    }

    // Bombs: ballistic fall, detonate on ground or on grazing an enemy body.
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vel.y -= BOMB_GRAVITY * dt;
      b.pos.addScaledVector(b.vel, dt);
      let boom = b.pos.y <= 0;
      if (!boom) {
        for (const e of this.enemies) {
          if (e.hp > 0 && b.pos.distanceTo(e.mesh.position) <= e.bodyRadius) { boom = true; break; }
        }
      }
      if (boom) {
        if (b.pos.y < 0) b.pos.y = 0;
        this.explode(b.pos);
        this.scene.remove(b.mesh);
        this.bombs.splice(i, 1);
      } else {
        b.mesh.position.copy(b.pos);
      }
    }

    // Enemies fire projectiles; the projectiles decide hits as they travel.
    for (const e of this.enemies) {
      if (e.hp > 0) this.updateEnemy(e, dronePos, dt);
    }
    const damage = this.updateBullets(dronePos, dt, invulnerable);

    // Effects: grow/fade blasts.
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const fx = this.blasts[i];
      fx.life -= dt;
      const t = 1 - Math.max(0, fx.life) / fx.max;
      fx.mesh.scale.setScalar(0.1 + t * BLAST_RADIUS * 1.6);
      fx.mesh.material.opacity = 0.8 * (1 - t);
      if (fx.life <= 0) {
        this.scene.remove(fx.mesh);
        fx.mesh.material.dispose();
        this.blasts.splice(i, 1);
      }
    }

    if (this.status === 'active' && this.enemiesLeft === 0) this.status = 'won';
    return { damage };
  }

  /**
   * Advance every projectile, testing the swept segment against the drone so a
   * fast bullet can't tunnel past between frames. A hit removes the bullet and,
   * unless invulnerable, removes health. Bullets also expire by lifetime.
   * @param {THREE.Vector3} dronePos
   * @param {number} dt
   * @param {boolean} invulnerable
   * @returns {number} Total health lost this frame.
   */
  updateBullets(dronePos, dt, invulnerable) {
    let damage = 0;
    const r2 = BULLET_HIT_RADIUS * BULLET_HIT_RADIUS;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      b.life -= dt;

      const hit = !invulnerable && distSqSegPoint(b.prev, b.pos, dronePos) <= r2;
      if (hit) {
        damage += b.dmg;
        this.droneHp = Math.max(0, this.droneHp - b.dmg);
        if (this.droneHp <= 0) this.status = 'lost';
      }
      if (hit || b.life <= 0) {
        this.scene.remove(b.mesh);
        this.bullets.splice(i, 1);
      }
    }
    return damage;
  }

  /** @returns {number} Charge fraction [0,1] of the currently regenerating bomb (1 when full). */
  get regenProgress() {
    return this.bombStock >= BOMB_MAX ? 1 : Math.min(1, this.regenTimer / BOMB_REGEN);
  }

  /** @returns {number} Enemies still alive. */
  get enemiesLeft() {
    let n = 0;
    for (const e of this.enemies) if (e.hp > 0) n++;
    return n;
  }

  /** @returns {number} Enemies destroyed so far. */
  get killed() {
    return this.total - this.enemiesLeft;
  }

  /** Remove every mission object from the scene and free GPU resources. */
  dispose() {
    for (const e of this.enemies) {
      this.scene.remove(e.mesh);
      this.scene.remove(e.laser);
      e.laser.geometry.dispose();
    }
    for (const b of this.bombs) this.scene.remove(b.mesh);
    for (const b of this.bullets) this.scene.remove(b.mesh);
    for (const fx of this.blasts) { this.scene.remove(fx.mesh); fx.mesh.material.dispose(); }
    this.laserMat.dispose();
    this.bulletGeo.dispose();
    this.bulletMat.dispose();
    this.bombGeo.dispose();
    this.bombMat.dispose();
    this.blastGeo.dispose();
    this.blastMat.dispose();
  }
}
