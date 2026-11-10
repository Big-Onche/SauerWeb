import type { Vec3 } from "../map/types";
import { dot, magnitude, normalize, subtract } from "../physics/vector";
import type { Damageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { WEAPONS, type Gun } from "./WeaponDefinitions";

export interface WorldHit {
  position: Vec3;
  normal: Vec3;
  distance: number;
}

export interface WeaponWorld {
  raycast(origin: Vec3, direction: Vec3, maximumDistance: number, radius?: number): WorldHit | undefined;
}

export interface HitscanResult {
  endpoints: Vec3[];
  hits: Array<{ target: Damageable; pellets: number }>;
}

export class HitscanSystem {
  constructor(private readonly world: WeaponWorld, private readonly damage: DamageSystem,
              private readonly random: () => number = Math.random) {}

  fire(gun: Gun, attacker: Damageable, from: Vec3, target: Vec3, damageMultiplier: number,
       targets: readonly Damageable[]): HitscanResult {
    const definition = WEAPONS[gun];
    const baseDirection = subtract(target, from);
    const range = Math.min(definition.range, magnitude(baseDirection));
    normalize(baseDirection);
    const endpoints: Vec3[] = [];
    const targetHits = new Map<Damageable, number>();
    for (let ray = 0; ray < definition.rays; ray++) {
      const endpoint = definition.spread ? this.spreadEndpoint(from, baseDirection, range, definition.spread) : addDistance(from, baseDirection, range);
      const direction = subtract(endpoint, from);
      const maximumDistance = magnitude(direction);
      normalize(direction);
      const worldDistance = this.world.raycast(from, direction, maximumDistance)?.distance ?? maximumDistance;
      let bestTarget: Damageable | undefined;
      let bestDistance = worldDistance;
      for (const candidate of targets) {
        if (candidate === attacker || !candidate.alive) continue;
        const distance = lineCylinderIntersection(from, direction, bestDistance, candidate);
        if (distance !== undefined && distance < bestDistance) {
          bestDistance = distance;
          bestTarget = candidate;
        }
      }
      endpoints.push(addDistance(from, direction, bestDistance));
      if (bestTarget) targetHits.set(bestTarget, (targetHits.get(bestTarget) ?? 0) + 1);
    }
    const hits: Array<{ target: Damageable; pellets: number }> = [];
    targetHits.forEach((pellets, hitTarget) => {
      const direction = subtract(target, from);
      normalize(direction);
      this.damage.damage(hitTarget, attacker, definition.damage * damageMultiplier * pellets, direction, gun);
      hits.push({ target: hitTarget, pellets });
    });
    return { endpoints, hits };
  }

  private spreadEndpoint(from: Vec3, direction: Vec3, range: number, spread: number): Vec3 {
    let offset: Vec3;
    do {
      offset = { x: this.random() - 0.5, y: this.random() - 0.5, z: this.random() - 0.5 };
    } while (dot(offset, offset) > 0.25);
    const scale = range / 1024 * spread;
    offset.x *= scale;
    offset.y *= scale;
    offset.z *= scale / 2;
    const endpoint = addDistance(from, direction, range);
    endpoint.x += offset.x;
    endpoint.y += offset.y;
    endpoint.z += offset.z;
    return endpoint;
  }
}

export function lineCylinderIntersection(origin: Vec3, direction: Vec3, maximumDistance: number,
                                         target: Damageable): number | undefined {
  const dx = origin.x - target.position.x, dy = origin.y - target.position.y;
  const a = direction.x * direction.x + direction.y * direction.y;
  const b = 2 * (dx * direction.x + dy * direction.y);
  const c = dx * dx + dy * dy - target.radius * target.radius;
  const candidates: number[] = [];
  const discriminant = b * b - 4 * a * c;
  if (a >= 1e-12 && discriminant >= 0) {
    const root = Math.sqrt(discriminant);
    candidates.push((-b - root) / (2 * a), (-b + root) / (2 * a));
  }
  if (Math.abs(direction.z) >= 1e-12) {
    candidates.push((target.position.z - target.eyeHeight - origin.z) / direction.z,
      (target.position.z + target.aboveEye - origin.z) / direction.z);
  }
  candidates.sort((first, second) => first - second);
  for (const distance of candidates) {
    if (distance < 0 || distance > maximumDistance) continue;
    const z = origin.z + direction.z * distance;
    const x = origin.x + direction.x * distance - target.position.x;
    const y = origin.y + direction.y * distance - target.position.y;
    if (z >= target.position.z - target.eyeHeight && z <= target.position.z + target.aboveEye && x * x + y * y <= target.radius * target.radius) {
      return distance;
    }
  }
  return undefined;
}

export function addDistance(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}
