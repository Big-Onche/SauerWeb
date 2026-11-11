import type { Vec3 } from "../../engine/octa";
import { addScaled, copyVec3, magnitude, normalize, subtract } from "../../engine/physics/vector";
import type { Damageable } from "./DamageSystem";
import { HitscanSystem, type WeaponWorld } from "./HitscanSystem";
import { ProjectileSystem } from "./ProjectileSystem";
import { Gun, WEAPONS } from "./WeaponDefinitions";
import type { WeaponEvents } from "./WeaponEvents";
import { WeaponInventory } from "./WeaponInventory";

export class WeaponController {
  readonly inventory = new WeaponInventory();
  attacking = false;
  lastAction = 0;
  gunWait = 0;
  lastAttackGun = -1;
  quadMilliseconds = 0;

  constructor(readonly owner: Damageable, private readonly world: WeaponWorld, private readonly hitscan: HitscanSystem,
              private readonly projectiles: ProjectileSystem, private readonly events: WeaponEvents) {}

  // Original: src/fpsgame/weapon.cpp
  // Function: shoot()
  // Sauerbraten reference: SVN r6488
  shoot(nowMilliseconds: number, target: Vec3, targets: readonly Damageable[]): boolean {
    if (!this.owner.alive || !this.attacking || nowMilliseconds - this.lastAction < this.gunWait) return false;
    const gun = this.inventory.selectedGun;
    this.lastAction = nowMilliseconds;
    this.lastAttackGun = gun;
    if (!this.inventory.consume(gun)) {
      this.events.emit({ type: "no-ammo", gun });
      this.gunWait = 600;
      this.lastAttackGun = -1;
      this.select(this.inventory.automaticSwitch());
      return false;
    }
    const definition = WEAPONS[gun];
    const from = copyVec3(this.owner.position);
    const direction = subtract(target, from);
    normalize(direction);
    const aimedDistance = Math.min(definition.range, magnitude(subtract(target, from)));
    let to = { x: from.x + direction.x * aimedDistance, y: from.y + direction.y * aimedDistance, z: from.z + direction.z * aimedDistance };
    const barrier = this.world.raycast(from, direction, aimedDistance);
    if (barrier) to = copyVec3(barrier.position);
    addScaled(this.owner.velocity, direction, definition.kickAmount * -2.5);
    const multiplier = this.quadMilliseconds > 0 ? 4 : 1;
    let rays: Vec3[] = [];
    if (definition.projectileSpeed) this.projectiles.spawn(gun, this.owner, from, to, multiplier);
    else rays = this.hitscan.fire(gun, this.owner, from, to, multiplier, targets).endpoints;
    this.events.emit({ type: "shot", gun, from, to, rays });
    this.gunWait = definition.attackDelay;
    return true;
  }

  update(nowMilliseconds: number, target: Vec3, targets: readonly Damageable[]): boolean {
    return this.shoot(nowMilliseconds, target, targets);
  }

  setAttacking(attacking: boolean): void {
    this.attacking = attacking;
  }

  select(gun: Gun, force = false): boolean {
    const previous = this.inventory.selectedGun;
    if (!this.inventory.select(gun, force)) {
      this.events.emit({ type: "no-ammo", gun });
      return false;
    }
    if (gun !== previous) this.events.emit({ type: "selected", gun });
    return true;
  }

  cycle(direction: number, force = false): boolean {
    const gun = this.inventory.cycle(direction, force);
    if (gun === undefined) {
      this.events.emit({ type: "no-ammo", gun: this.inventory.selectedGun });
      return false;
    }
    return this.select(gun, force);
  }

  respawn(nowMilliseconds = 0): void {
    this.inventory.respawn();
    this.attacking = false;
    this.lastAction = nowMilliseconds;
    this.gunWait = 0;
    this.lastAttackGun = -1;
    this.quadMilliseconds = 0;
  }
}
