import type { Vec3 } from "../engine/octa";
import type { Damageable } from "./weapon/DamageSystem";
import { DamageSystem } from "./weapon/DamageSystem";
import { ExplosionSystem } from "./weapon/ExplosionSystem";
import { HitscanSystem, type WeaponWorld } from "./weapon/HitscanSystem";
import { ProjectileSystem } from "./weapon/ProjectileSystem";
import { WeaponController } from "./weapon/WeaponController";
import { WeaponEvents } from "./weapon/WeaponEvents";

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

  update(nowMilliseconds: number, aimTarget: Vec3): boolean {
    const elapsed = this.previousUpdate ? Math.min(100, Math.max(0, nowMilliseconds - this.previousUpdate)) : 0;
    this.previousUpdate = nowMilliseconds;
    if (this.controller.quadMilliseconds > 0) this.controller.quadMilliseconds = Math.max(0, this.controller.quadMilliseconds - elapsed);
    const fired = this.controller.shoot(nowMilliseconds, aimTarget, this.targets);
    if (elapsed > 0) this.projectiles.update(elapsed, this.targets);
    return fired;
  }

  resetClock(nowMilliseconds: number): void {
    this.previousUpdate = nowMilliseconds;
    this.controller.setAttacking(false);
  }
}
