import type { Vec3 } from "../map/types";
import type { Damageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import { HitscanSystem, type WeaponWorld } from "./HitscanSystem";
import { ProjectileSystem } from "./ProjectileSystem";
import { WeaponController } from "./WeaponController";
import { WeaponEvents } from "./WeaponEvents";

export class WeaponSystem {
  readonly events = new WeaponEvents();
  readonly damage = new DamageSystem(this.events);
  readonly explosions = new ExplosionSystem(this.damage, this.events);
  readonly hitscan: HitscanSystem;
  readonly projectiles: ProjectileSystem;
  readonly controller: WeaponController;
  readonly targets: Damageable[] = [];
  private previousUpdate = 0;

  constructor(world: WeaponWorld, player: Damageable, random: () => number = Math.random) {
    this.hitscan = new HitscanSystem(world, this.damage, random);
    this.projectiles = new ProjectileSystem(world, this.damage, this.explosions, this.events);
    this.controller = new WeaponController(player, world, this.hitscan, this.projectiles, this.events);
    this.targets.push(player);
  }

  update(nowMilliseconds: number, aimTarget: Vec3): void {
    const elapsed = this.previousUpdate ? Math.min(100, Math.max(0, nowMilliseconds - this.previousUpdate)) : 0;
    this.previousUpdate = nowMilliseconds;
    if (this.controller.quadMilliseconds > 0) this.controller.quadMilliseconds = Math.max(0, this.controller.quadMilliseconds - elapsed);
    this.controller.update(nowMilliseconds, aimTarget, this.targets);
    if (elapsed > 0) this.projectiles.update(elapsed, this.targets);
  }

  resetClock(nowMilliseconds: number): void {
    this.previousUpdate = nowMilliseconds;
    this.controller.setAttacking(false);
  }
}
