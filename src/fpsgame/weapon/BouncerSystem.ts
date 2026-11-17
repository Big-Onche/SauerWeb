import { MATF_VOLUME, MAT_LAVA, MAT_WATER } from "../../engine/material";
import type { Vec3 } from "../../engine/octa";
import { GRAVITY, PHYSICS_FRAME_TIME_MS } from "../../engine/physics/constants";
import { addScaled, copyVec3, magnitude, normalize, rescale, scaleVec3, subtract } from "../../engine/physics/vector";
import type { Damageable } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import type { WeaponWorld } from "./HitscanSystem";
import { Gun, WEAPONS } from "./WeaponDefinitions";
import type { WeaponEvents } from "./WeaponEvents";

export enum BouncerType {
  BNC_GRENADE,
  BNC_GIBS,
  BNC_DEBRIS,
  BNC_BARRELDEBRIS,
}

export interface Bouncer {
  id: number;
  key: string;
  bouncetype: BouncerType;
  owner: Damageable;
  local: boolean;
  position: Vec3;
  previousPosition: Vec3;
  velocity: Vec3;
  radius: number;
  lifetime: number;
  bounces: number;
  lastyaw: number;
  roll: number;
  offset: Vec3;
  offsetmillis: number;
  offsetheight: number;
  variant: number;
  damageMultiplier: number;
  physicsState: "fall" | "bounce";
}

interface BouncerScratch {
  old: Vec3;
  displacement: Vec3;
  direction: Vec3;
  trial: Vec3;
  contact: Vec3;
  visualPosition: Vec3;
}

interface ActiveBouncer extends Bouncer {
  scratch: BouncerScratch;
  renderDirty: boolean;
  smoke: boolean;
  fade: number;
}

export interface NewBouncerOptions {
  local?: boolean;
  id?: number;
  nowMilliseconds?: number;
  visualOrigin?: Vec3;
  firstPerson?: boolean;
  damageMultiplier?: number;
}

const OFFSETMILLIS = 500;
const PREWARMED_BOUNCERS = 1024;

/** Faithful gameplay port of weapon.cpp's native bouncer list and physics.cpp's bounce(). */
export class BouncerSystem {
  private readonly bouncers: ActiveBouncer[] = [];
  private readonly bouncerPool: ActiveBouncer[] = [];
  private readonly spawnDirection: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly spawnTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private accumulator = 0;
  private nextId = 1;
  serverAuthoritative = false;

  constructor(private readonly world: WeaponWorld, private readonly explosions: ExplosionSystem, private readonly events: WeaponEvents,
              private readonly random: () => number = Math.random) {
    for (let index = 0; index < PREWARMED_BOUNCERS; index++) this.bouncerPool.push(createPooledBouncer());
    events.on((event) => {
      if (event.type === "death") this.gibeffect(Math.max(-event.target.health, 0), event.target.velocity, event.target);
    });
  }

  // Original: src/fpsgame/weapon.cpp newbouncer().
  newbouncer(from: Vec3, to: Vec3, owner: Damageable, type: BouncerType, lifetime: number, speed: number,
             options: NewBouncerOptions = {}): Bouncer {
    const local = options.local ?? true;
    const id = options.id ?? options.nowMilliseconds ?? this.nextId++;
    const radius = type === BouncerType.BNC_DEBRIS ? 0.5 : 1.5;
    const bouncer = this.acquireBouncer();
    const direction = bouncer.scratch.direction;
    setDifference(direction, to, from);
    normalize(direction);
    copyTo(bouncer.position, from);
    avoidcollision(bouncer.position, radius, direction, owner, 0.1);
    bouncer.id = id;
    bouncer.key = `${owner.id}:${id}`;
    bouncer.bouncetype = type;
    bouncer.owner = owner;
    bouncer.local = local;
    copyTo(bouncer.previousPosition, bouncer.position);
    copyTo(bouncer.velocity, direction);
    bouncer.radius = radius;
    bouncer.lifetime = lifetime;
    bouncer.bounces = 0;
    bouncer.lastyaw = 0;
    bouncer.roll = 0;
    setDifference(bouncer.offset, options.visualOrigin ?? from, bouncer.position);
    bouncer.offsetmillis = OFFSETMILLIS;
    bouncer.offsetheight = -1;
    bouncer.variant = type === BouncerType.BNC_GIBS ? this.rnd(3) : type >= BouncerType.BNC_DEBRIS ? this.rnd(4) : 0;
    bouncer.damageMultiplier = options.damageMultiplier ?? 1;
    bouncer.physicsState = "fall";
    bouncer.renderDirty = false;
    bouncer.smoke = false;
    bouncer.fade = 1;
    scaleVec3(bouncer.velocity, speed);
    this.limitoffset(bouncer);
    this.bouncers.push(bouncer);
    this.events.emit({ type: "bouncer-spawned", key: bouncer.key, id, ownerId: owner.id, bouncerType: type,
      position: this.offsetpos(bouncer), velocity: copyVec3(bouncer.velocity), variant: bouncer.variant });
    return bouncer;
  }

  spawnGrenadeShot(owner: Damageable, from: Vec3, target: Vec3, damageMultiplier: number, options: NewBouncerOptions = {}): number {
    const adjustedTarget = copyVec3(target);
    adjustedTarget.z += magnitude(subtract(target, from)) / 8;
    const firstPerson = options.firstPerson ?? false;
    const visualOrigin = copyVec3(options.visualOrigin ?? hudgunorigin(from, target, owner, firstPerson));
    if (firstPerson) {
      const offset = subtract(visualOrigin, owner.position);
      rescale(offset, 16);
      visualOrigin.x = owner.position.x + offset.x;
      visualOrigin.y = owner.position.y + offset.y;
      visualOrigin.z = owner.position.z + offset.z;
    }
    return this.newbouncer(from, adjustedTarget, owner, BouncerType.BNC_GRENADE, WEAPONS[Gun.Grenade].projectileLifetime,
      WEAPONS[Gun.Grenade].projectileSpeed, { ...options, visualOrigin, damageMultiplier }).id;
  }

  spawnGrenade(from: Vec3, to: Vec3, owner: Damageable, options: NewBouncerOptions = {}): Bouncer {
    const aimed = copyVec3(to);
    aimed.z += magnitude(subtract(to, from)) / 8;
    return this.newbouncer(from, aimed, owner, BouncerType.BNC_GRENADE, WEAPONS[Gun.Grenade].projectileLifetime,
      WEAPONS[Gun.Grenade].projectileSpeed, options);
  }

  // Original: src/fpsgame/weapon.cpp
  // Functions: spawnbouncer(vec &p, gameent *d, int type), gibeffect(int damage, const vec &vel, gameent *d)
  // Sauerbraten reference: SVN r6488
  spawnbouncer(position: Vec3, owner: Damageable, type: BouncerType): Bouncer {
    const direction = this.spawnDirection;
    direction.x = this.rnd(100) - 50;
    direction.y = this.rnd(100) - 50;
    direction.z = this.rnd(100) - 50;
    if (direction.x === 0 && direction.y === 0 && direction.z === 0) direction.z = 1;
    normalize(direction);
    const target = this.spawnTarget;
    copyTo(target, position);
    addScaled(target, direction, 1);
    return this.newbouncer(position, target, owner, type, this.rnd(1000) + 1000, this.rnd(100) + 20);
  }

  gibeffect(damage: number, _velocity: Vec3, target: Damageable): void {
    if (damage <= 0) return;
    const origin = { ...target.position, z: target.position.z + target.aboveEye };
    for (let index = 0; index < Math.min(Math.trunc(damage / 25), 40) + 1; index++) {
      this.spawnbouncer(origin, target, BouncerType.BNC_GIBS);
    }
  }

  // Original: src/fpsgame/weapon.cpp
  // Functions: updatebouncers(int time)
  // Sauerbraten reference: SVN r6488
  // Grenades use the engine's fixed 5 ms physics clock.
  updatebouncers(milliseconds: number, targets: readonly Damageable[]): void {
    const elapsed = Math.max(0, milliseconds);
    for (let remaining = elapsed; remaining > 0;) {
      const quantum = Math.min(30, remaining);
      remaining -= quantum;
      this.step(quantum, targets, false);
    }
    this.accumulator += elapsed;
    while (this.accumulator >= PHYSICS_FRAME_TIME_MS) {
      this.step(PHYSICS_FRAME_TIME_MS, targets, true);
      this.accumulator -= PHYSICS_FRAME_TIME_MS;
    }
    this.syncVisuals();
  }

  removebouncers(owner: Damageable): void {
    for (let index = this.bouncers.length - 1; index >= 0; index--) {
      if (this.bouncers[index].owner === owner) this.remove(index);
    }
  }

  clearbouncers(): void {
    for (let index = this.bouncers.length - 1; index >= 0; index--) this.remove(index);
    this.accumulator = 0;
  }

  explodeeffects(owner: Damageable, id: number): boolean {
    const index = this.bouncers.findIndex((bouncer) => bouncer.owner === owner && bouncer.id === id &&
      bouncer.bouncetype === BouncerType.BNC_GRENADE);
    if (index < 0) return false;
    const bouncer = this.bouncers[index];
    const position = this.offsetpos(bouncer);
    this.events.emit({ type: "explosion", gun: Gun.Grenade, position,
      radius: WEAPONS[Gun.Grenade].explosionRadius });
    this.spawndebris(position, owner);
    this.events.emit({ type: "bouncer-removed", key: bouncer.key });
    this.bouncers.splice(index, 1);
    this.releaseBouncer(bouncer);
    return true;
  }

  get activeCount(): number { return this.bouncers.length; }
  get activeBouncers(): readonly Bouncer[] { return this.bouncers; }

  offsetpos(bouncer: Bouncer): Vec3 {
    const position = copyVec3(bouncer.position);
    this.offsetposToRef(bouncer, position);
    return position;
  }

  private step(milliseconds: number, targets: readonly Damageable[], grenades: boolean): void {
    for (let index = this.bouncers.length - 1; index >= 0; index--) {
      const bouncer = this.bouncers[index];
      if ((bouncer.bouncetype === BouncerType.BNC_GRENADE) !== grenades) continue;
      copyTo(bouncer.previousPosition, bouncer.position);
      const speed = vectorLength(bouncer.velocity);
      bouncer.smoke ||= bouncer.bouncetype === BouncerType.BNC_GRENADE && speed > 50;
      let stopped: boolean;
      if (bouncer.bouncetype === BouncerType.BNC_GRENADE) {
        stopped = this.bounce(bouncer, milliseconds / 1000, 0.5, 0.8, 0.6, targets);
        bouncer.lifetime -= milliseconds;
        stopped ||= bouncer.lifetime <= 0;
      } else {
        bouncer.lifetime -= milliseconds;
        stopped = bouncer.lifetime <= 0 || this.bounce(bouncer, milliseconds / 1000, 0.6, 0.5, 1, targets);
      }
      if (stopped) {
        if (bouncer.bouncetype === BouncerType.BNC_GRENADE) this.detonate(bouncer, targets);
        this.remove(index);
        continue;
      }
      bouncer.roll += distanceBetween(bouncer.previousPosition, bouncer.position) / (4 * Math.PI / 180);
      bouncer.offsetmillis = Math.max(0, bouncer.offsetmillis - milliseconds);
      this.limitoffset(bouncer);
      if (vectorLength(bouncer.velocity) > 25) {
        bouncer.lastyaw = Math.atan2(bouncer.velocity.y, bouncer.velocity.x) * 180 / Math.PI + 90;
      }
      bouncer.fade = bouncer.bouncetype !== BouncerType.BNC_GRENADE && bouncer.lifetime < 250 ? bouncer.lifetime / 250 : 1;
      bouncer.renderDirty = true;
    }
  }

  // Original: src/engine/physics.cpp
  // Functions: bounce(physent *d, float secs, float elasticity, float waterfric, float grav)
  // Sauerbraten reference: SVN r6488
  private bounce(bouncer: ActiveBouncer, seconds: number, elasticity: number, waterfric: number, grav: number,
                 targets: readonly Damageable[]): boolean {
    const scratch = bouncer.scratch;
    scratch.direction.x = scratch.direction.y = scratch.direction.z = 0;
    if (bouncer.physicsState !== "bounce" && this.world.collideBouncer?.(bouncer.position, bouncer.radius, scratch.direction)) {
      return true;
    }
    const material = this.world.lookupMaterial?.(bouncer.position) ?? 0;
    const volume = material & MATF_VOLUME;
    const water = volume === MAT_WATER || volume === MAT_LAVA;
    if (water) {
      bouncer.velocity.z -= grav * GRAVITY / 16 * seconds;
      scaleVec3(bouncer.velocity, Math.max(1 - seconds / waterfric, 0));
    } else bouncer.velocity.z -= grav * GRAVITY * seconds;
    const old = scratch.old;
    copyTo(old, bouncer.position);
    let collideplayer = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const displacement = scratch.displacement;
      displacement.x = bouncer.velocity.x * seconds;
      displacement.y = bouncer.velocity.y * seconds;
      displacement.z = bouncer.velocity.z * seconds;
      const distance = vectorLength(displacement);
      const direction = scratch.direction;
      if (distance > 0) {
        const inverseDistance = 1 / distance;
        direction.x = displacement.x * inverseDistance;
        direction.y = displacement.y * inverseDistance;
        direction.z = displacement.z * inverseDistance;
      } else direction.x = direction.y = direction.z = 0;
      const trial = scratch.trial;
      trial.x = old.x + displacement.x;
      trial.y = old.y + displacement.y;
      trial.z = old.z + displacement.z;
      const preciseCollision = this.world.collideBouncer?.(trial, bouncer.radius, displacement);
      const worldHit = distance > 0 ? this.world.raycast(old, direction, distance, bouncer.radius, true) : undefined;
      let playerDistance = Number.POSITIVE_INFINITY;
      for (const target of targets) {
        if (target === bouncer.owner || !target.alive) continue;
        const hit = lineCylinderIntersectionExpanded(old, direction, distance, target, bouncer.radius);
        if (hit !== undefined) playerDistance = Math.min(playerDistance, hit);
      }
      if (Number.isFinite(playerDistance) && playerDistance <= (worldHit?.distance ?? Number.POSITIVE_INFINITY)) {
        collideplayer = true;
        break;
      }
      const collisionNormal = preciseCollision?.normal ?? worldHit?.normal;
      if (!collisionNormal) {
        copyTo(bouncer.position, trial);
        break;
      }
      copyTo(bouncer.position, old);
      const contact = scratch.contact;
      if (worldHit) copyTo(contact, worldHit.position);
      else {
        contact.x = trial.x - collisionNormal.x * bouncer.radius;
        contact.y = trial.y - collisionNormal.y * bouncer.radius;
        contact.z = trial.z - collisionNormal.z * bouncer.radius;
      }
      this.bounced(bouncer, collisionNormal, contact);
      const collisionDot = collisionNormal.x * bouncer.velocity.x + collisionNormal.y * bouncer.velocity.y +
        collisionNormal.z * bouncer.velocity.z;
      const speed = vectorLength(bouncer.velocity);
      const energy = speed > 0 ? 1 + (1 - elasticity) * collisionDot / speed : 0;
      scaleVec3(bouncer.velocity, energy);
      addScaled(bouncer.velocity, collisionNormal, -elasticity * 2 * collisionDot);
    }
    if (bouncer.physicsState !== "bounce") {
      if (samePosition(bouncer.position, old)) return !collideplayer;
      bouncer.physicsState = "bounce";
    }
    return collideplayer;
  }

  private bounced(bouncer: ActiveBouncer, surface: Vec3, contact: Vec3): void {
    if (bouncer.bouncetype !== BouncerType.BNC_GIBS || bouncer.bounces >= 2) return;
    bouncer.bounces++;
    this.events.emit({ type: "bouncer-impact", key: bouncer.key, bouncerType: bouncer.bouncetype,
      position: copyVec3(contact), normal: copyVec3(surface), bounces: bouncer.bounces });
  }

  private detonate(bouncer: Bouncer, targets: readonly Damageable[]): void {
    const damage = WEAPONS[Gun.Grenade].damage * bouncer.damageMultiplier;
    const hits = bouncer.local
      ? this.explosions.explode(Gun.Grenade, bouncer.owner, bouncer.position, damage, targets, undefined, !this.serverAuthoritative)
      : [];
    if (!bouncer.local) this.events.emit({ type: "explosion", gun: Gun.Grenade, position: copyVec3(bouncer.position),
      radius: WEAPONS[Gun.Grenade].explosionRadius });
    this.spawndebris(bouncer.position, bouncer.owner);
    this.events.emit({ type: "bouncer-exploded", key: bouncer.key, id: bouncer.id, ownerId: bouncer.owner.id,
      local: bouncer.local, position: copyVec3(bouncer.position), hits });
  }

  private limitoffset(bouncer: Bouncer): void {
    if (bouncer.bouncetype !== BouncerType.BNC_GRENADE || bouncer.offsetmillis <= 0 || bouncer.offset.z >= 0) {
      bouncer.offsetheight = -1;
      return;
    }
    const active = bouncer as ActiveBouncer;
    const origin = active.scratch.trial;
    origin.x = bouncer.position.x + bouncer.offset.x;
    origin.y = bouncer.position.y + bouncer.offset.y;
    origin.z = bouncer.position.z;
    const down = active.scratch.direction;
    down.x = down.y = 0;
    down.z = -1;
    bouncer.offsetheight = this.world.raycast(origin, down, -bouncer.offset.z)?.distance ?? -1;
  }

  private remove(index: number): void {
    const bouncer = this.bouncers[index];
    this.events.emit({ type: "bouncer-removed", key: bouncer.key });
    this.bouncers.splice(index, 1);
    this.releaseBouncer(bouncer);
  }

  private syncVisuals(): void {
    for (const bouncer of this.bouncers) {
      if (!bouncer.renderDirty) continue;
      this.offsetposToRef(bouncer, bouncer.scratch.visualPosition);
      this.events.emit({
        type: "bouncer-moved", key: bouncer.key, position: copyVec3(bouncer.scratch.visualPosition),
        velocity: copyVec3(bouncer.velocity), yaw: bouncer.lastyaw, roll: bouncer.roll, smoke: bouncer.smoke, fade: bouncer.fade,
      });
      bouncer.renderDirty = false;
      bouncer.smoke = false;
    }
  }

  private offsetposToRef(bouncer: Bouncer, result: Vec3): void {
    copyTo(result, bouncer.position);
    if (bouncer.offsetmillis > 0) addScaled(result, bouncer.offset, bouncer.offsetmillis / OFFSETMILLIS);
    if (bouncer.offsetheight >= 0) {
      result.z = Math.max(result.z, bouncer.position.z - Math.max(bouncer.offsetheight - bouncer.radius, 0));
    }
  }

  private acquireBouncer(): ActiveBouncer {
    return this.bouncerPool.pop() ?? createPooledBouncer();
  }

  private releaseBouncer(bouncer: ActiveBouncer): void {
    bouncer.owner = undefined as unknown as Damageable;
    bouncer.key = "";
    bouncer.renderDirty = false;
    bouncer.smoke = false;
    this.bouncerPool.push(bouncer);
  }

  spawndebris(position: Vec3, owner: Damageable): void {
    const count = this.rnd(20) + 5; // maxdebris defaults to 25: rnd(maxdebris - 5) + 5.
    for (let index = 0; index < count; index++) this.spawnbouncer(position, owner, BouncerType.BNC_DEBRIS);
  }

  private rnd(range: number): number { return Math.floor(this.random() * range); }
}

// Original: src/engine/physics.cpp
// Functions: avoidcollision(physent *d, const vec &dir, physent *obstacle, float space)
// Sauerbraten reference: SVN r6488
export function avoidcollision(position: Vec3, radius: number, direction: Vec3, obstacle: Damageable, space: number): void {
  const combinedRadius = obstacle.radius + radius;
  const minimumX = obstacle.position.x - combinedRadius - space;
  const minimumY = obstacle.position.y - combinedRadius - space;
  const minimumZ = obstacle.position.z - obstacle.eyeHeight - radius - space;
  const maximumX = obstacle.position.x + combinedRadius + space;
  const maximumY = obstacle.position.y + combinedRadius + space;
  const maximumZ = obstacle.position.z + obstacle.aboveEye + radius + space;
  if (position.x <= minimumX || position.x >= maximumX || position.y <= minimumY || position.y >= maximumY ||
      position.z <= minimumZ || position.z >= maximumZ) return;
  let minimumDistance = 1e16;
  if (direction.x !== 0) minimumDistance = Math.min(minimumDistance,
    ((direction.x > 0 ? maximumX : minimumX) - position.x) / direction.x);
  if (direction.y !== 0) minimumDistance = Math.min(minimumDistance,
    ((direction.y > 0 ? maximumY : minimumY) - position.y) / direction.y);
  if (direction.z !== 0) minimumDistance = Math.min(minimumDistance,
    ((direction.z > 0 ? maximumZ : minimumZ) - position.z) / direction.z);
  addScaled(position, direction, minimumDistance);
}

// Original: src/fpsgame/render.cpp
// Functions: hudgunorigin(int gun, const vec &from, const vec &to, gameent *d)
// Sauerbraten reference: SVN r6488
// Uses the native offsets; a tagged muzzle can override through visualOrigin.
export function hudgunorigin(from: Vec3, to: Vec3, owner: Damageable, firstPerson: boolean): Vec3 {
  const front = subtract(to, from);
  normalize(front);
  const result = copyVec3(from);
  if (firstPerson) {
    addScaled(result, front, 2);
    result.z -= 1;
    const right = { x: front.y, y: -front.x, z: 0 };
    normalize(right);
    addScaled(result, right, 0.8);
    return result;
  }
  addScaled(result, front, owner.radius + 1);
  result.z += (owner.aboveEye + owner.eyeHeight) * 0.75 - owner.eyeHeight;
  const right = { x: front.y, y: -front.x, z: 0 };
  normalize(right);
  addScaled(result, right, 0.5 * owner.radius);
  return result;
}

function samePosition(first: Vec3, second: Vec3): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function copyTo(target: Vec3, source: Vec3): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function setDifference(result: Vec3, first: Vec3, second: Vec3): void {
  result.x = first.x - second.x;
  result.y = first.y - second.y;
  result.z = first.z - second.z;
}

function vectorLength(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function distanceBetween(first: Vec3, second: Vec3): number {
  return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
}

function createPooledBouncer(): ActiveBouncer {
  const vector = (): Vec3 => ({ x: 0, y: 0, z: 0 });
  return {
    id: 0, key: "", bouncetype: BouncerType.BNC_GRENADE, owner: undefined as unknown as Damageable, local: true,
    position: vector(), previousPosition: vector(), velocity: vector(), radius: 0, lifetime: 0, bounces: 0, lastyaw: 0, roll: 0,
    offset: vector(), offsetmillis: 0, offsetheight: -1, variant: 0, damageMultiplier: 1, physicsState: "fall",
    scratch: { old: vector(), displacement: vector(), direction: vector(), trial: vector(), contact: vector(), visualPosition: vector() },
    renderDirty: false, smoke: false, fade: 1,
  };
}

/** Allocation-free equivalent of intersectclosest against a radius-expanded dynent cylinder. */
function lineCylinderIntersectionExpanded(origin: Vec3, direction: Vec3, maximumDistance: number, target: Damageable,
                                          expansion: number): number | undefined {
  const startX = target.position.x;
  const startY = target.position.y;
  const startZ = target.position.z - (target.eyeHeight + expansion);
  const endZ = target.position.z + target.aboveEye + expansion;
  const axisZ = endZ - startZ;
  const segmentX = origin.x + direction.x * maximumDistance - origin.x;
  const segmentY = origin.y + direction.y * maximumDistance - origin.y;
  const segmentZ = origin.z + direction.z * maximumDistance - origin.z;
  const relativeX = origin.x - startX;
  const relativeY = origin.y - startY;
  const relativeZ = origin.z - startZ;
  const md = relativeZ * axisZ;
  const nd = segmentZ * axisZ;
  const dd = axisZ * axisZ;
  if (md < 0 && md + nd < 0 || md > dd && md + nd > dd) return undefined;
  const nn = segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ;
  const mn = relativeX * segmentX + relativeY * segmentY + relativeZ * segmentZ;
  const a = dd * nn - nd * nd;
  const radius = target.radius + expansion;
  const relativeSquared = relativeX * relativeX + relativeY * relativeY + relativeZ * relativeZ;
  const k = relativeSquared - radius * radius;
  const c = dd * k - md * md;
  let fraction: number;
  if (Math.abs(a) < 0.005) {
    if (c > 0) return undefined;
    fraction = md < 0 ? -mn / nn : md > dd ? (nd - mn) / nn : 0;
  } else if (c > 0) {
    const b = dd * mn - nd * md;
    const discriminant = b * b - a * c;
    if (discriminant < 0) return undefined;
    fraction = (-b - Math.sqrt(discriminant)) / a;
  } else fraction = 0;
  const offset = md + fraction * nd;
  if (offset < 0) {
    if (nd <= 0) return undefined;
    fraction = -md / nd;
    if (k + fraction * (2 * mn + fraction * nn) > 0) return undefined;
  } else if (offset > dd) {
    if (nd >= 0) return undefined;
    fraction = (dd - md) / nd;
    if (k + dd - 2 * md + fraction * (2 * (mn - nd) + fraction * nn) > 0) return undefined;
  }
  return fraction >= 0 && fraction <= 1 ? fraction * maximumDistance : undefined;
}
