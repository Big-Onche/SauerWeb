import { describe, expect, it } from "vitest";
import type { Vec3 } from "../engine/octa";
import { createDamageable, createDebugTarget, DamageSystem, ArmourType } from "./weapon/DamageSystem";
import type { WeaponWorld } from "./weapon/HitscanSystem";
import { Gun, SAUERBRATEN_SOURCE_REVISION, WEAPONS } from "./weapon/WeaponDefinitions";
import { WeaponEvents } from "./weapon/WeaponEvents";
import { WeaponInventory } from "./weapon/WeaponInventory";
import { WeaponSystem } from "./weapon";

const emptyWorld: WeaponWorld = { raycast: () => undefined };

describe("Sauerbraten weapon parity", () => {
  it("ports the native player gun table without changing IDs or values", () => {
    expect(SAUERBRATEN_SOURCE_REVISION).toBe("SVN r6488");
    expect(WEAPONS.slice(0, 7).map((weapon) => [weapon.id, weapon.attackDelay, weapon.damage, weapon.spread,
      weapon.projectileSpeed, weapon.kickAmount, weapon.range, weapon.rays, weapon.hitPush, weapon.explosionRadius,
      weapon.projectileLifetime])).toEqual([
      [0, 250, 50, 0, 0, 0, 14, 1, 80, 0, 0],
      [1, 1400, 10, 400, 0, 20, 1024, 20, 80, 0, 0],
      [2, 100, 30, 100, 0, 7, 1024, 1, 80, 0, 0],
      [3, 800, 120, 0, 320, 10, 1024, 1, 160, 40, 0],
      [4, 1500, 100, 0, 0, 30, 2048, 1, 80, 0, 0],
      [5, 600, 90, 0, 200, 10, 1024, 1, 250, 45, 1500],
      [6, 500, 35, 50, 0, 7, 1024, 1, 80, 0, 0],
    ]);
  });

  it("uses native spawn ammo and automatic weapon preference", () => {
    const inventory = new WeaponInventory();
    expect(inventory.selectedGun).toBe(Gun.Pistol);
    expect(inventory.ammo[Gun.Pistol]).toBe(40);
    expect(inventory.ammo[Gun.Grenade]).toBe(1);
    expect(inventory.ammo[Gun.Fist]).toBe(1);
    inventory.ammo[Gun.Chaingun] = 2;
    expect(inventory.automaticSwitch()).toBe(Gun.Chaingun);
  });

  it("can grant the complete maximum-ammo debug loadout", () => {
    const inventory = new WeaponInventory();
    inventory.grantMaximumAmmo();
    expect(Array.from(inventory.ammo.slice(0, 7))).toEqual([1, 30, 60, 15, 15, 30, 120]);
  });

  it("creates configurable debug targets for local damage tests", () => {
    const target = createDebugTarget("dummy", vector(1, 2, 3), { health: 250, radius: 6, eyeHeight: 18, aboveEye: 3, weight: 150 });
    expect(target).toMatchObject({ health: 250, maxHealth: 250, radius: 6, eyeHeight: 18, aboveEye: 3, weight: 150, alive: true });
  });

  it("gates held fire by simulation time and applies physical kickback once per accepted shot", () => {
    const player = createDamageable("player", vector());
    const system = new WeaponSystem(emptyWorld, player, () => 0.5);
    system.controller.inventory.ammo[Gun.Chaingun] = 3;
    system.controller.select(Gun.Chaingun);
    system.controller.setAttacking(true);
    const target = vector(0, 100, 0);
    system.update(1000, target);
    system.update(1050, target);
    expect(system.controller.inventory.ammo[Gun.Chaingun]).toBe(2);
    expect(player.velocity.y).toBeCloseTo(-17.5);
    system.update(1100, target);
    expect(system.controller.inventory.ammo[Gun.Chaingun]).toBe(1);
    expect(player.velocity.y).toBeCloseTo(-35);
  });

  it("absorbs damage using native blue, green, and yellow armour percentages", () => {
    const events = new WeaponEvents();
    const damage = new DamageSystem(events);
    const attacker = createDamageable("attacker", vector());
    for (const [armourType, absorbed] of [[ArmourType.Blue, 25], [ArmourType.Green, 50], [ArmourType.Yellow, 75]] as const) {
      const target = createDamageable("target", vector(0, 10));
      target.armour = 100;
      target.armourType = armourType;
      const result = damage.damage(target, attacker, 100, vector(0, 1), Gun.Rifle);
      expect(result.absorbed).toBe(absorbed);
      expect(result.applied).toBe(100 - absorbed);
    }
  });

  it("groups shotgun pellets into one damage application", () => {
    const player = createDamageable("player", vector());
    const target = createDamageable("dummy", vector(0, 50));
    target.radius = 20;
    const system = new WeaponSystem(emptyWorld, player, () => 0.5);
    system.targets.push(target);
    system.controller.inventory.ammo[Gun.Shotgun] = 1;
    system.controller.select(Gun.Shotgun);
    system.controller.setAttacking(true);
    system.update(1000, vector(0, 100));
    expect(target.health).toBe(-100);
    expect(target.alive).toBe(false);
  });

  it("detonates grenades on their native 1500 ms fuse", () => {
    const player = createDamageable("player", vector());
    const system = new WeaponSystem(emptyWorld, player);
    let exploded = false;
    system.events.on((event) => { if (event.type === "explosion") exploded = true; });
    system.projectiles.spawn(Gun.Grenade, player, vector(), vector(0, 100), 1);
    system.projectiles.update(1499, system.targets);
    expect(exploded).toBe(false);
    system.projectiles.update(1, system.targets);
    expect(exploded).toBe(true);
  });

  it("detonates rockets at the native range endpoint when the world is clear", () => {
    const player = createDamageable("player", vector());
    const system = new WeaponSystem(emptyWorld, player);
    let explosion: Vec3 | undefined;
    system.events.on((event) => { if (event.type === "explosion") explosion = event.position; });
    system.projectiles.spawn(Gun.Rocket, player, vector(), vector(0, 1024), 1);
    system.projectiles.update(3199, system.targets);
    expect(explosion).toBeUndefined();
    system.projectiles.update(1, system.targets);
    expect(explosion).toEqual(vector(0, 1024));
  });
});

function vector(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}
