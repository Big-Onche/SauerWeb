import type { Vec3 } from "../../engine/octa";
import { magnitude, normalize, subtract } from "../../engine/physics/vector";
import { DamageSystem, type Damageable } from "./DamageSystem";
import { EXPLOSION_DISTANCE_SCALE, EXPLOSION_SELF_DAMAGE_DIVISOR, WEAPONS, type Gun } from "./WeaponDefinitions";
import type { WeaponEvents } from "./WeaponEvents";
import type { WeaponHit } from "./WeaponEvents";

export class ExplosionSystem {
  constructor(private readonly damage: DamageSystem, private readonly events: WeaponEvents) {}

  explode(gun: Gun, owner: Damageable, position: Vec3, baseDamage: number, targets: readonly Damageable[], safe?: Damageable,
          applyDamage = true): WeaponHit[] {
    const definition = WEAPONS[gun];
    const hits: WeaponHit[] = [];
    this.events.emit({ type: "explosion", gun, position: { ...position }, radius: definition.explosionRadius });
    for (const target of targets) {
      if (!target.alive || target === safe) continue;
      const middle = { ...target.position, z: target.position.z + (target.aboveEye - target.eyeHeight) / 2 };
      const direction = subtract(middle, position);
      const distance = magnitude(direction);
      if (distance >= definition.explosionRadius) continue;
      normalize(direction);
      let amount = Math.trunc(baseDamage * (1 - distance / EXPLOSION_DISTANCE_SCALE / definition.explosionRadius));
      if (target === owner) amount = Math.trunc(amount / EXPLOSION_SELF_DAMAGE_DIVISOR);
      hits.push({ target, distance, rays: 1, direction });
      if (applyDamage) this.damage.damage(target, owner, amount, direction, gun);
    }
    return hits;
  }
}
