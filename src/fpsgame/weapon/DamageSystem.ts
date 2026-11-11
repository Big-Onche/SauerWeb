import type { Vec3 } from "../../engine/octa";
import { addScaled, copyVec3 } from "../../engine/physics/vector";
import { EXPLOSION_SELF_PUSH, WEAPONS, type Gun } from "./WeaponDefinitions";
import type { WeaponEvents } from "./WeaponEvents";

export enum ArmourType {
  Blue = 0,
  Green = 1,
  Yellow = 2,
}

export interface Damageable {
  readonly id: string;
  position: Vec3;
  velocity: Vec3;
  radius: number;
  eyeHeight: number;
  aboveEye: number;
  weight: number;
  health: number;
  maxHealth: number;
  armour: number;
  armourType: ArmourType | number;
  alive: boolean;
}

export interface DamageResult {
  applied: number;
  absorbed: number;
  killed: boolean;
}

export class DamageSystem {
  constructor(private readonly events: WeaponEvents) {}

  damage(target: Damageable, attacker: Damageable, amount: number, direction: Vec3, gun: Gun): DamageResult {
    if (!target.alive || amount <= 0) return { applied: 0, absorbed: 0, killed: false };
    const absorbed = Math.min(target.armour, Math.trunc(amount * (target.armourType + 1) * 25 / 100));
    const applied = amount - absorbed;
    target.armour -= absorbed;
    target.health -= applied;
    const definition = WEAPONS[gun];
    const push = definition.hitPush * amount / target.weight * (target === attacker && definition.explosionRadius ? EXPLOSION_SELF_PUSH : 1);
    addScaled(target.velocity, direction, push);
    const killed = target.health <= 0;
    if (killed) target.alive = false;
    this.events.emit({ type: "damage", gun, target, amount: applied, absorbed });
    if (killed) this.events.emit({ type: "death", gun, target });
    return { applied, absorbed, killed };
  }
}

export function createDamageable(id: string, position: Vec3, health = 100): Damageable {
  return { id, position: copyVec3(position), velocity: { x: 0, y: 0, z: 0 }, radius: 4.1, eyeHeight: 14, aboveEye: 1,
    weight: 100, health, maxHealth: health, armour: 0, armourType: ArmourType.Blue, alive: true };
}

export interface DebugTargetOptions {
  health?: number;
  radius?: number;
  eyeHeight?: number;
  aboveEye?: number;
  weight?: number;
}

export function createDebugTarget(id: string, position: Vec3, options: DebugTargetOptions = {}): Damageable {
  const target = createDamageable(id, position, options.health ?? 100);
  target.radius = options.radius ?? target.radius;
  target.eyeHeight = options.eyeHeight ?? target.eyeHeight;
  target.aboveEye = options.aboveEye ?? target.aboveEye;
  target.weight = options.weight ?? target.weight;
  return target;
}
