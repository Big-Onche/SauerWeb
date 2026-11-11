import type { Vec3 } from "../../engine/octa";
import { GRAVITY } from "../../engine/physics/constants";
import { addScaled, copyVec3, dot, magnitude, normalize, scaleVec3, subtract } from "../../engine/physics/vector";
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
  private nextId = 1;

  constructor(private readonly world: WeaponWorld, private readonly damage: DamageSystem, private readonly explosions: ExplosionSystem,
              private readonly events: WeaponEvents) {}

  spawn(gun: Gun, owner: Damageable, from: Vec3, target: Vec3, damageMultiplier: number): number {
    const definition = WEAPONS[gun];
    const direction = subtract(target, from);
    if (gun === Gun.Grenade) direction.z += magnitude(direction) / 8;
    normalize(direction);
    const projectile: Projectile = { id: this.nextId++, gun, owner, position: copyVec3(from), velocity: direction,
      remaining: definition.projectileLifetime || Number.POSITIVE_INFINITY,
      remainingDistance: gun === Gun.Grenade ? Number.POSITIVE_INFINITY : magnitude(subtract(target, from)), damageMultiplier };
    scaleVec3(projectile.velocity, definition.projectileSpeed);
    this.projectiles.push(projectile);
    this.events.emit({ type: "projectile-spawned", gun, id: projectile.id, position: copyVec3(from) });
    return projectile.id;
  }

  update(milliseconds: number, targets: readonly Damageable[]): void {
    const seconds = milliseconds / 1000;
    for (let index = this.projectiles.length - 1; index >= 0; index--) {
      const projectile = this.projectiles[index];
      if (projectile.gun === Gun.Grenade) projectile.velocity.z -= GRAVITY * 0.8 * seconds;
      const travelDistance = magnitude(projectile.velocity) * seconds;
      const reachesEndpoint = travelDistance + 1e-6 >= projectile.remainingDistance;
      const distance = Math.min(travelDistance, projectile.remainingDistance);
      const direction = copyVec3(projectile.velocity);
      normalize(direction);
      const worldHit = this.world.raycast(projectile.position, direction, distance, projectile.gun === Gun.Grenade ? 1.5 : 0);
      let targetHit: Damageable | undefined;
      let hitDistance = worldHit?.distance ?? distance;
      if (projectile.gun !== Gun.Grenade) {
        for (const target of targets) {
          if (target === projectile.owner || !target.alive) continue;
          const candidate = lineCylinderIntersection(projectile.position, direction, hitDistance, target);
          if (candidate !== undefined && candidate < hitDistance) {
            hitDistance = candidate;
            targetHit = target;
          }
        }
      }
      if (projectile.gun === Gun.Grenade && worldHit) {
        projectile.position = addDistance(projectile.position, direction, Math.max(0, worldHit.distance - 0.05));
        const reflected = dot(projectile.velocity, worldHit.normal);
        const speed = magnitude(projectile.velocity);
        const elasticity = 0.5;
        scaleVec3(projectile.velocity, 1 + (1 - elasticity) * reflected / speed);
        addScaled(projectile.velocity, worldHit.normal, -elasticity * 2 * reflected);
      } else if (worldHit || targetHit) {
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
  }

  get activeCount(): number {
    return this.projectiles.length;
  }

  private detonate(projectile: Projectile, targets: readonly Damageable[], directTarget?: Damageable): void {
    const amount = WEAPONS[projectile.gun].damage * projectile.damageMultiplier;
    if (directTarget) {
      const direction = subtract(directTarget.position, projectile.position);
      normalize(direction);
      this.damage.damage(directTarget, projectile.owner, amount, direction, projectile.gun);
    }
    this.explosions.explode(projectile.gun, projectile.owner, projectile.position, amount, targets, directTarget);
  }
}
