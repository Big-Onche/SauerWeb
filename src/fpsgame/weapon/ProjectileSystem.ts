import type { Vec3 } from "../../engine/octa";
import { addScaled, copyVec3, magnitude, normalize, subtract } from "../../engine/physics/vector";
import { BouncerSystem, hudgunorigin } from "./BouncerSystem";
import type { Damageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import { lineCylinderIntersection, type WeaponWorld } from "./HitscanSystem";
import { Gun, WEAPONS } from "./WeaponDefinitions";
import type { WeaponEvents, WeaponHit } from "./WeaponEvents";

export const OFFSETMILLIS = 500;

export interface Projectile {
  id: number;
  key: string;
  gun: Gun;
  owner: Damageable;
  local: boolean;
  dir: Vec3;
  o: Vec3;
  to: Vec3;
  offset: Vec3;
  speed: number;
  offsetmillis: number;
  damageMultiplier: number;
}

export interface NewProjectileOptions {
  local?: boolean;
  id?: number;
  speed?: number;
}

export interface ProjectileRenderPose {
  position: Vec3;
  direction: Vec3;
  modelPosition: Vec3;
  yaw: number;
  pitch: number;
}

/** Faithful gameplay port of weapon.cpp's projectile list and updateprojectiles(). */
export class ProjectileSystem {
  private readonly projectiles: Projectile[] = [];
  readonly bouncers: BouncerSystem;
  private nextId = 1;
  serverAuthoritative = false;

  constructor(private readonly world: WeaponWorld, private readonly damage: DamageSystem, private readonly explosions: ExplosionSystem,
              private readonly events: WeaponEvents, random: () => number = Math.random) {
    this.bouncers = new BouncerSystem(world, explosions, events, random);
  }

  // Original: src/fpsgame/weapon.cpp newprojectile().
  newprojectile(from: Vec3, to: Vec3, speed: number, local: boolean, id: number, owner: Damageable, gun: Gun,
                visualOrigin?: Vec3, firstPerson = false, damageMultiplier = 1): Projectile {
    const key = projectileKey(owner, gun, id);
    const existing = this.projectiles.find((projectile) => projectile.key === key);
    if (existing) return existing;
    const dir = subtract(to, from);
    normalize(dir);
    const offset = subtract(visualOrigin ?? hudgunorigin(from, to, owner, firstPerson), from);
    const projectile: Projectile = {
      id, key, gun, owner, local, dir, o: copyVec3(from), to: copyVec3(to), offset, speed,
      offsetmillis: OFFSETMILLIS, damageMultiplier,
    };
    this.projectiles.push(projectile);
    this.emitSpawned(projectile);
    return projectile;
  }

  spawn(gun: Gun, owner: Damageable, from: Vec3, target: Vec3, damageMultiplier: number, nowMilliseconds?: number,
        visualOrigin?: Vec3, firstPerson = false, options: NewProjectileOptions = {}): number {
    if (gun === Gun.Grenade) {
      return this.bouncers.spawnGrenadeShot(owner, from, target, damageMultiplier, {
        nowMilliseconds, visualOrigin, firstPerson, local: options.local, id: options.id,
      });
    }
    const local = options.local ?? true;
    const id = options.id ?? nowMilliseconds ?? this.nextId++;
    const speed = options.speed ?? WEAPONS[gun].projectileSpeed * (owner.monster ? 0.5 : 1);
    return this.newprojectile(from, target, speed, local, id, owner, gun,
      visualOrigin, firstPerson, damageMultiplier).id;
  }

  // Original: src/fpsgame/weapon.cpp updateprojectiles().
  updateprojectiles(milliseconds: number, targets: readonly Damageable[]): void {
    this.bouncers.serverAuthoritative = this.serverAuthoritative;
    this.bouncers.updatebouncers(milliseconds, targets);
    const time = Math.max(0, milliseconds);
    for (let index = this.projectiles.length - 1; index >= 0; index--) {
      const projectile = this.projectiles[index];
      projectile.offsetmillis = Math.max(projectile.offsetmillis - time, 0);
      const remainingDistance = magnitude(subtract(projectile.to, projectile.o));
      const distance = Math.min(remainingDistance, projectile.speed * time / 1000);
      const v = copyVec3(projectile.o);
      addScaled(v, projectile.dir, distance);
      let targetHit: Damageable | undefined;
      let hitDistance = distance;
      if (projectile.local) {
        for (const target of targets) {
          if (target === projectile.owner || !target.alive) continue;
          const candidate = lineCylinderIntersection(projectile.o, projectile.dir, hitDistance, target);
          if (candidate !== undefined && candidate <= hitDistance) {
            hitDistance = candidate;
            targetHit = target;
          }
        }
      }
      const worldHit = distance > 0 ? this.world.raycast(projectile.o, projectile.dir, hitDistance) : undefined;
      if (worldHit && worldHit.distance <= hitDistance) {
        targetHit = undefined;
        hitDistance = worldHit.distance;
      }
      if (targetHit || worldHit || remainingDistance < 4) {
        const impact = worldHit ? copyVec3(projectile.o) : v;
        if (worldHit) addScaled(impact, projectile.dir, hitDistance);
        this.projsplash(projectile, impact, targets, targetHit);
        this.remove(index);
        continue;
      }
      projectile.o = v;
      this.emitMoved(projectile);
    }
  }

  update(milliseconds: number, targets: readonly Damageable[]): void { this.updateprojectiles(milliseconds, targets); }

  // Original: src/fpsgame/weapon.cpp explodeeffects().
  explodeeffects(gun: Gun, owner: Damageable, id: number): boolean {
    if (gun === Gun.Grenade) return this.bouncers.explodeeffects(owner, id);
    if (gun !== Gun.Rocket) return false;
    const index = this.projectiles.findIndex((projectile) => projectile.gun === gun && projectile.owner === owner &&
      projectile.id === id && !projectile.local);
    if (index < 0) return false;
    const projectile = this.projectiles[index];
    const position = projectileVisualPosition(projectile);
    this.events.emit({ type: "explosion", gun, position: copyVec3(position), radius: WEAPONS[gun].explosionRadius });
    this.rocketdebris(projectile, position);
    this.events.emit({ type: "projectile-removed", key: projectile.key });
    this.projectiles.splice(index, 1);
    return true;
  }

  removeprojectiles(owner: Damageable): void {
    for (let index = this.projectiles.length - 1; index >= 0; index--) if (this.projectiles[index].owner === owner) this.remove(index);
  }

  clearprojectiles(): void {
    for (let index = this.projectiles.length - 1; index >= 0; index--) this.remove(index);
  }

  clear(): void {
    this.clearprojectiles();
    this.bouncers.clearbouncers();
  }

  get activeCount(): number { return this.projectiles.length + this.bouncers.activeCount; }
  get activeProjectiles(): readonly Projectile[] { return this.projectiles; }

  private projsplash(projectile: Projectile, position: Vec3, targets: readonly Damageable[], directTarget?: Damageable): void {
    const amount = WEAPONS[projectile.gun].damage * projectile.damageMultiplier / (projectile.owner.monster ? 4 : 1);
    const hits: WeaponHit[] = [];
    if (directTarget && projectile.local) {
      const direction = subtract(directTarget.position, position);
      normalize(direction);
      hits.push({ target: directTarget, distance: 0, rays: 1, direction });
      if (!this.serverAuthoritative) this.damage.damage(directTarget, projectile.owner, amount, direction, projectile.gun);
    }
    if (projectile.gun === Gun.Rocket) {
      const normal = { x: -projectile.dir.x, y: -projectile.dir.y, z: -projectile.dir.z };
      hits.push(...this.explosions.explode(projectile.gun, projectile.owner, position, amount, targets, directTarget,
        projectile.local && !this.serverAuthoritative, normal));
      this.rocketdebris(projectile, position);
    } else this.events.emit({ type: "explosion", gun: projectile.gun, position: copyVec3(position),
      radius: WEAPONS[projectile.gun].explosionRadius });
    this.events.emit({ type: "projectile-exploded", key: projectile.key, gun: projectile.gun, id: projectile.id,
      ownerId: projectile.owner.id, local: projectile.local, position: copyVec3(position), hits });
  }

  private emitSpawned(projectile: Projectile): void {
    this.events.emit({ type: "projectile-spawned", key: projectile.key, gun: projectile.gun, id: projectile.id,
      ownerId: projectile.owner.id, local: projectile.local, position: copyVec3(projectile.o), destination: copyVec3(projectile.to),
      direction: copyVec3(projectile.dir), offset: copyVec3(projectile.offset), offsetMillis: projectile.offsetmillis });
  }

  private emitMoved(projectile: Projectile): void {
    this.events.emit({ type: "projectile-moved", key: projectile.key, gun: projectile.gun, position: copyVec3(projectile.o),
      destination: copyVec3(projectile.to), direction: copyVec3(projectile.dir), offset: copyVec3(projectile.offset),
      offsetMillis: projectile.offsetmillis });
  }

  private remove(index: number): void {
    this.events.emit({ type: "projectile-removed", key: this.projectiles[index].key });
    this.projectiles.splice(index, 1);
  }

  private rocketdebris(projectile: Projectile, position: Vec3): void {
    const origin = copyVec3(position);
    const towardOwner = subtract(projectile.owner.position, position);
    normalize(towardOwner);
    addScaled(origin, towardOwner, 8);
    this.bouncers.spawndebris(origin, projectile.owner);
  }
}

export function projectileKey(owner: Damageable, gun: Gun, id: number): string { return `${owner.id}:${gun}:${id}`; }

export function projectileVisualPosition(projectile: Pick<Projectile, "o" | "offset" | "offsetmillis">): Vec3 {
  const position = copyVec3(projectile.o);
  addScaled(position, projectile.offset, projectile.offsetmillis / OFFSETMILLIS);
  return position;
}

// Original: src/fpsgame/weapon.cpp renderprojectiles().
export function projectileRenderPose(projectile: Pick<Projectile, "o" | "to" | "offset" | "offsetmillis" | "dir">): ProjectileRenderPose {
  const dist = Math.min(magnitude(subtract(projectile.o, projectile.to)) / 32, 1);
  const position = copyVec3(projectile.o);
  addScaled(position, projectile.offset, dist * projectile.offsetmillis / OFFSETMILLIS);
  const direction = dist < 1e-6 ? copyVec3(projectile.dir) : subtract(projectile.to, position);
  normalize(direction);
  const yaw = Math.atan2(-direction.x, direction.y) * 180 / Math.PI + 90;
  const pitch = Math.atan2(direction.z, Math.hypot(direction.x, direction.y)) * 180 / Math.PI;
  const modelPosition = copyVec3(position);
  addScaled(modelPosition, direction, 3);
  return { position, direction, modelPosition, yaw, pitch };
}
