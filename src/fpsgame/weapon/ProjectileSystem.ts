import type { Vec3 } from "../../engine/octa";
import { copyVec3, magnitude, normalize, scaleVec3, subtract } from "../../engine/physics/vector";
import { BouncerSystem } from "./BouncerSystem";
import type { Damageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import { addDistance, lineCylinderIntersection, type WeaponWorld } from "./HitscanSystem";
import { Gun, WEAPONS } from "./WeaponDefinitions";
import type { WeaponEvents } from "./WeaponEvents";

interface Projectile {
  id: number;
  gun: Gun;
  owner: Damageable;
  position: Vec3;
  velocity: Vec3;
  remaining: number;
  remainingDistance: number;
  damageMultiplier: number;
}

export class ProjectileSystem {
  private readonly projectiles: Projectile[] = [];
  readonly bouncers: BouncerSystem;
  private nextId = 1;
  serverAuthoritative = false;

  constructor(private readonly world: WeaponWorld, private readonly damage: DamageSystem, private readonly explosions: ExplosionSystem,
              private readonly events: WeaponEvents, random: () => number = Math.random) {
    this.bouncers = new BouncerSystem(world, explosions, events, random);
  }

  spawn(gun: Gun, owner: Damageable, from: Vec3, target: Vec3, damageMultiplier: number, nowMilliseconds?: number,
        visualOrigin?: Vec3, firstPerson = false): number {
    const definition = WEAPONS[gun];
    if (gun === Gun.Grenade) {
      return this.bouncers.spawnGrenadeShot(owner, from, target, damageMultiplier, { nowMilliseconds, visualOrigin, firstPerson });
    }
    const direction = subtract(target, from);
    normalize(direction);
    const projectile: Projectile = { id: this.nextId++, gun, owner, position: copyVec3(from), velocity: direction,
      remaining: definition.projectileLifetime || Number.POSITIVE_INFINITY,
      remainingDistance: magnitude(subtract(target, from)), damageMultiplier };
    scaleVec3(projectile.velocity, definition.projectileSpeed);
    this.projectiles.push(projectile);
    this.events.emit({ type: "projectile-spawned", gun, id: projectile.id, position: copyVec3(from) });
    return projectile.id;
  }

  update(milliseconds: number, targets: readonly Damageable[]): void {
    this.bouncers.serverAuthoritative = this.serverAuthoritative;
    this.bouncers.updatebouncers(milliseconds, targets);
    const seconds = milliseconds / 1000;
    for (let index = this.projectiles.length - 1; index >= 0; index--) {
      const projectile = this.projectiles[index];
      const travelDistance = magnitude(projectile.velocity) * seconds;
      const reachesEndpoint = travelDistance + 1e-6 >= projectile.remainingDistance;
      const distance = Math.min(travelDistance, projectile.remainingDistance);
      const direction = copyVec3(projectile.velocity);
      normalize(direction);
      const worldHit = this.world.raycast(projectile.position, direction, distance);
      let targetHit: Damageable | undefined;
      let hitDistance = worldHit?.distance ?? distance;
      for (const target of targets) {
        if (target === projectile.owner || !target.alive) continue;
        const candidate = lineCylinderIntersection(projectile.position, direction, hitDistance, target);
        if (candidate !== undefined && candidate < hitDistance) {
          hitDistance = candidate;
          targetHit = target;
        }
      }
      if (worldHit || targetHit) {
        projectile.position = addDistance(projectile.position, direction, hitDistance);
        this.detonate(projectile, targets, targetHit);
        this.projectiles.splice(index, 1);
        continue;
      } else projectile.position = addDistance(projectile.position, direction, distance);
      projectile.remainingDistance -= distance;
      projectile.remaining -= milliseconds;
      if (projectile.remaining <= 0 || reachesEndpoint) {
        this.detonate(projectile, targets);
        this.projectiles.splice(index, 1);
        continue;
      }
      this.events.emit({ type: "projectile-moved", gun: projectile.gun, id: projectile.id, position: copyVec3(projectile.position) });
    }
  }

  clear(): void {
    this.projectiles.length = 0;
    this.bouncers.clearbouncers();
  }

  get activeCount(): number {
    return this.projectiles.length + this.bouncers.activeCount;
  }

  private detonate(projectile: Projectile, targets: readonly Damageable[], directTarget?: Damageable): void {
    const amount = WEAPONS[projectile.gun].damage * projectile.damageMultiplier;
    if (directTarget && !this.serverAuthoritative) {
      const direction = subtract(directTarget.position, projectile.position);
      normalize(direction);
      this.damage.damage(directTarget, projectile.owner, amount, direction, projectile.gun);
    }
    this.explosions.explode(projectile.gun, projectile.owner, projectile.position, amount, targets, directTarget,
      !this.serverAuthoritative);
  }
}
