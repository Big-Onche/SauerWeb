import { MATF_VOLUME, MAT_LAVA, MAT_WATER } from "../../engine/material";
import type { Vec3 } from "../../engine/octa";
import { GRAVITY, PHYSICS_FRAME_TIME_MS } from "../../engine/physics/constants";
import { addScaled, copyVec3, dot, magnitude, normalize, rescale, scaleVec3, subtract } from "../../engine/physics/vector";
import type { Damageable } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import { lineCylinderIntersection, type WeaponWorld } from "./HitscanSystem";
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

export interface NewBouncerOptions {
  local?: boolean;
  id?: number;
  nowMilliseconds?: number;
  visualOrigin?: Vec3;
  damageMultiplier?: number;
}

const OFFSETMILLIS = 500;

/** Faithful gameplay port of weapon.cpp's native bouncer list and physics.cpp's bounce(). */
export class BouncerSystem {
  private readonly bouncers: Bouncer[] = [];
  private accumulator = 0;
  private nextId = 1;
  serverAuthoritative = false;

  constructor(private readonly world: WeaponWorld, private readonly explosions: ExplosionSystem, private readonly events: WeaponEvents,
              private readonly random: () => number = Math.random) {
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
    const direction = subtract(to, from);
    normalize(direction);
    const position = copyVec3(from);
    avoidcollision(position, radius, direction, owner, 0.1);
    const bouncer: Bouncer = {
      id,
      key: `${owner.id}:${id}`,
      bouncetype: type,
      owner,
      local,
      position,
      previousPosition: copyVec3(position),
      velocity: copyVec3(direction),
      radius,
      lifetime,
      bounces: 0,
      lastyaw: 0,
      roll: 0,
      offset: subtract(options.visualOrigin ?? from, position),
      offsetmillis: OFFSETMILLIS,
      offsetheight: -1,
      variant: type === BouncerType.BNC_GIBS ? this.rnd(3) : type >= BouncerType.BNC_DEBRIS ? this.rnd(4) : 0,
      damageMultiplier: options.damageMultiplier ?? 1,
      physicsState: "fall",
    };
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
    const visualOrigin = options.visualOrigin ?? hudgunorigin(from, target, owner, options.local ?? true);
    return this.newbouncer(from, adjustedTarget, owner, BouncerType.BNC_GRENADE, WEAPONS[Gun.Grenade].projectileLifetime,
      WEAPONS[Gun.Grenade].projectileSpeed, { ...options, visualOrigin, damageMultiplier }).id;
  }

  spawnGrenade(from: Vec3, to: Vec3, owner: Damageable, options: NewBouncerOptions = {}): Bouncer {
    const aimed = copyVec3(to);
    aimed.z += magnitude(subtract(to, from)) / 8;
    return this.newbouncer(from, aimed, owner, BouncerType.BNC_GRENADE, WEAPONS[Gun.Grenade].projectileLifetime,
      WEAPONS[Gun.Grenade].projectileSpeed, options);
  }

  // Original: src/fpsgame/weapon.cpp spawnbouncer()/gibeffect().
  spawnbouncer(position: Vec3, owner: Damageable, type: BouncerType): Bouncer {
    const direction = { x: this.rnd(100) - 50, y: this.rnd(100) - 50, z: this.rnd(100) - 50 };
    if (direction.x === 0 && direction.y === 0 && direction.z === 0) direction.z = 1;
    normalize(direction);
    const target = copyVec3(position);
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

  // Original: src/fpsgame/weapon.cpp updatebouncers(). Grenades use the engine's fixed 5 ms physics clock.
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
    return true;
  }

  get activeCount(): number { return this.bouncers.length; }
  get activeBouncers(): readonly Bouncer[] { return this.bouncers; }

  offsetpos(bouncer: Bouncer): Vec3 {
    const position = copyVec3(bouncer.position);
    if (bouncer.offsetmillis > 0) addScaled(position, bouncer.offset, bouncer.offsetmillis / OFFSETMILLIS);
    if (bouncer.offsetheight >= 0) position.z = Math.max(position.z,
      bouncer.position.z - Math.max(bouncer.offsetheight - bouncer.radius, 0));
    return position;
  }

  private step(milliseconds: number, targets: readonly Damageable[], grenades: boolean): void {
    for (let index = this.bouncers.length - 1; index >= 0; index--) {
      const bouncer = this.bouncers[index];
      if ((bouncer.bouncetype === BouncerType.BNC_GRENADE) !== grenades) continue;
      bouncer.previousPosition = copyVec3(bouncer.position);
      const smoke = bouncer.bouncetype === BouncerType.BNC_GRENADE && magnitude(bouncer.velocity) > 50;
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
      bouncer.roll += magnitude(subtract(bouncer.previousPosition, bouncer.position)) / (4 * Math.PI / 180);
      bouncer.offsetmillis = Math.max(0, bouncer.offsetmillis - milliseconds);
      this.limitoffset(bouncer);
      if (magnitude(bouncer.velocity) > 25) bouncer.lastyaw = Math.atan2(bouncer.velocity.y, bouncer.velocity.x) * 180 / Math.PI + 90;
      this.events.emit({ type: "bouncer-moved", key: bouncer.key, position: this.offsetpos(bouncer),
        velocity: copyVec3(bouncer.velocity), yaw: bouncer.lastyaw, roll: bouncer.roll, smoke,
        fade: bouncer.bouncetype !== BouncerType.BNC_GRENADE && bouncer.lifetime < 250 ? bouncer.lifetime / 250 : 1 });
    }
  }

  // Original: src/engine/physics.cpp bounce(physent *, float, float, float, float).
  private bounce(bouncer: Bouncer, seconds: number, elasticity: number, waterfric: number, grav: number,
                 targets: readonly Damageable[]): boolean {
    if (bouncer.physicsState !== "bounce" && this.world.collideBouncer?.(bouncer.position, bouncer.radius, { x: 0, y: 0, z: 0 })) {
      return true;
    }
    const material = this.world.lookupMaterial?.(bouncer.position) ?? 0;
    const volume = material & MATF_VOLUME;
    const water = volume === MAT_WATER || volume === MAT_LAVA;
    if (water) {
      bouncer.velocity.z -= grav * GRAVITY / 16 * seconds;
      scaleVec3(bouncer.velocity, Math.max(1 - seconds / waterfric, 0));
    } else bouncer.velocity.z -= grav * GRAVITY * seconds;
    const old = copyVec3(bouncer.position);
    let collideplayer = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const displacement = copyVec3(bouncer.velocity);
      scaleVec3(displacement, seconds);
      const distance = magnitude(displacement);
      const direction = copyVec3(displacement);
      normalize(direction);
      const trial = copyVec3(old);
      addScaled(trial, bouncer.velocity, seconds);
      const preciseCollision = this.world.collideBouncer?.(trial, bouncer.radius, displacement);
      const worldHit = distance > 0 ? this.world.raycast(old, direction, distance, bouncer.radius, true) : undefined;
      let playerDistance = Number.POSITIVE_INFINITY;
      for (const target of targets) {
        if (target === bouncer.owner || !target.alive) continue;
        const hit = lineCylinderIntersection(old, direction, distance, expandedTarget(target, bouncer.radius));
        if (hit !== undefined) playerDistance = Math.min(playerDistance, hit);
      }
      if (Number.isFinite(playerDistance) && playerDistance <= (worldHit?.distance ?? Number.POSITIVE_INFINITY)) {
        collideplayer = true;
        break;
      }
      const collisionNormal = preciseCollision?.normal ?? worldHit?.normal;
      if (!collisionNormal) {
        bouncer.position = trial;
        break;
      }
      bouncer.position = copyVec3(old);
      this.bounced(bouncer, collisionNormal);
      const collisionDot = dot(collisionNormal, bouncer.velocity);
      const speed = magnitude(bouncer.velocity);
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

  private bounced(bouncer: Bouncer, surface: Vec3): void {
    if (bouncer.bouncetype !== BouncerType.BNC_GIBS || bouncer.bounces >= 2) return;
    bouncer.bounces++;
    this.events.emit({ type: "bouncer-impact", key: bouncer.key, bouncerType: bouncer.bouncetype,
      position: copyVec3(bouncer.position), normal: copyVec3(surface), bounces: bouncer.bounces });
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
    const origin = { x: bouncer.position.x + bouncer.offset.x, y: bouncer.position.y + bouncer.offset.y, z: bouncer.position.z };
    bouncer.offsetheight = this.world.raycast(origin, { x: 0, y: 0, z: -1 }, -bouncer.offset.z)?.distance ?? -1;
  }

  private remove(index: number): void {
    this.events.emit({ type: "bouncer-removed", key: this.bouncers[index].key });
    this.bouncers.splice(index, 1);
  }

  private spawndebris(position: Vec3, owner: Damageable): void {
    const count = this.rnd(20) + 5; // maxdebris defaults to 25: rnd(maxdebris - 5) + 5.
    for (let index = 0; index < count; index++) this.spawnbouncer(position, owner, BouncerType.BNC_DEBRIS);
  }

  private rnd(range: number): number { return Math.floor(this.random() * range); }
}

// Original: src/engine/physics.cpp avoidcollision().
export function avoidcollision(position: Vec3, radius: number, direction: Vec3, obstacle: Damageable, space: number): void {
  const combinedRadius = obstacle.radius + radius;
  const minimum = { x: obstacle.position.x - combinedRadius - space, y: obstacle.position.y - combinedRadius - space,
    z: obstacle.position.z - obstacle.eyeHeight - radius - space };
  const maximum = { x: obstacle.position.x + combinedRadius + space, y: obstacle.position.y + combinedRadius + space,
    z: obstacle.position.z + obstacle.aboveEye + radius + space };
  if (position.x <= minimum.x || position.x >= maximum.x || position.y <= minimum.y || position.y >= maximum.y ||
      position.z <= minimum.z || position.z >= maximum.z) return;
  let minimumDistance = 1e16;
  for (const axis of ["x", "y", "z"] as const) {
    if (direction[axis] === 0) continue;
    minimumDistance = Math.min(minimumDistance,
      ((direction[axis] > 0 ? maximum[axis] : minimum[axis]) - position[axis]) / direction[axis]);
  }
  addScaled(position, direction, minimumDistance);
}

// Original: src/fpsgame/render.cpp hudgunorigin(). Uses the native offsets; a tagged muzzle can override through visualOrigin.
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
    const offset = subtract(result, owner.position);
    rescale(offset, 16);
    return { x: owner.position.x + offset.x, y: owner.position.y + offset.y, z: owner.position.z + offset.z };
  }
  addScaled(result, front, owner.radius + 1);
  result.z += (owner.aboveEye + owner.eyeHeight) * 0.75 - owner.eyeHeight;
  const right = { x: front.y, y: -front.x, z: 0 };
  normalize(right);
  addScaled(result, right, 0.5 * owner.radius);
  return result;
}

function expandedTarget(target: Damageable, radius: number): Damageable {
  return { ...target, radius: target.radius + radius, eyeHeight: target.eyeHeight + radius, aboveEye: target.aboveEye + radius };
}

function samePosition(first: Vec3, second: Vec3): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}
