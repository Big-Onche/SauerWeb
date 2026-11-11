import type { Vec3 } from "../../engine/octa";
import { dot, magnitude, normalize, subtract } from "../../engine/physics/vector";
import type { Damageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { WEAPONS, type Gun } from "./WeaponDefinitions";
import type { WeaponHit } from "./WeaponEvents";

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
  hits: WeaponHit[];
}

export class HitscanSystem {
  constructor(private readonly world: WeaponWorld, private readonly damage: DamageSystem,
              private readonly random: () => number = Math.random) {}

  // Original: src/fpsgame/weapon.cpp
  // Function: raydamage()
  // Sauerbraten reference: SVN r6488
  fire(gun: Gun, attacker: Damageable, from: Vec3, target: Vec3, damageMultiplier: number, targets: readonly Damageable[],
       applyDamage = true): HitscanResult {
    const definition = WEAPONS[gun];
    const baseDirection = subtract(target, from);
    const aimedDistance = magnitude(baseDirection);
    normalize(baseDirection);
    const endpoints: Vec3[] = [];
    const targetHits = new Map<Damageable, { rays: number; endpoint: Vec3 }>();
    for (let ray = 0; ray < definition.rays; ray++) {
      const endpoint = definition.spread
        ? this.spreadEndpoint(target, aimedDistance, definition.spread)
        : addDistance(from, baseDirection, aimedDistance);
      const direction = subtract(endpoint, from);
      const maximumDistance = definition.spread ? definition.range : magnitude(direction);
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
      const hitEndpoint = addDistance(from, direction, bestDistance);
      endpoints.push(hitEndpoint);
      if (bestTarget) {
        const grouped = targetHits.get(bestTarget);
        targetHits.set(bestTarget, { rays: (grouped?.rays ?? 0) + 1, endpoint: grouped?.endpoint ?? hitEndpoint });
      }
    }
    const hits: WeaponHit[] = [];
    targetHits.forEach(({ rays: rayCount, endpoint }, hitTarget) => {
      const hitTo = definition.rays > 1 ? target : endpoint;
      const direction = subtract(hitTo, from), distance = magnitude(direction);
      normalize(direction);
      if (applyDamage) this.damage.damage(hitTarget, attacker, definition.damage * damageMultiplier * rayCount, direction, gun);
      hits.push({ target: hitTarget, distance, rays: rayCount, direction });
    });
    return { endpoints, hits };
  }

  private spreadEndpoint(target: Vec3, aimedDistance: number, spread: number): Vec3 {
    let offset: Vec3;
    do {
      offset = { x: this.random() - 0.5, y: this.random() - 0.5, z: this.random() - 0.5 };
    } while (dot(offset, offset) > 0.25);
    const scale = aimedDistance / 1024 * spread;
    offset.x *= scale;
    offset.y *= scale;
    offset.z *= scale / 2;
    const endpoint = { ...target };
    endpoint.x += offset.x;
    endpoint.y += offset.y;
    endpoint.z += offset.z;
    return endpoint;
  }
}

export function lineCylinderIntersection(origin: Vec3, direction: Vec3, maximumDistance: number,
                                         target: Damageable): number | undefined {
  const to = addDistance(origin, direction, maximumDistance);
  const start = { x: target.position.x, y: target.position.y, z: target.position.z - target.eyeHeight };
  const end = { x: target.position.x, y: target.position.y, z: target.position.z + target.aboveEye };
  const d = subtract(end, start), m = subtract(origin, start), n = subtract(to, origin);
  const md = dot(m, d), nd = dot(n, d), dd = dot(d, d);
  if (md < 0 && md + nd < 0 || md > dd && md + nd > dd) return undefined;
  const nn = dot(n, n), mn = dot(m, n), a = dd * nn - nd * nd;
  const k = dot(m, m) - target.radius * target.radius, c = dd * k - md * md;
  let fraction: number;
  if (Math.abs(a) < 0.005) {
    if (c > 0) return undefined;
    fraction = md < 0 ? -mn / nn : md > dd ? (nd - mn) / nn : 0;
  } else if (c > 0) {
    const b = dd * mn - nd * md, discriminant = b * b - a * c;
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

export function addDistance(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}
