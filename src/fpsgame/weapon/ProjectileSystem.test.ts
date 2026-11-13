import { describe, expect, it } from "vitest";
import { createDamageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import type { WeaponWorld } from "./HitscanSystem";
import { OFFSETMILLIS, ProjectileSystem, projectileRenderPose } from "./ProjectileSystem";
import { Gun } from "./WeaponDefinitions";
import { WeaponEvents, type WeaponEvent } from "./WeaponEvents";

const emptyWorld: WeaponWorld = { raycast: () => undefined };

function createSystem(world: WeaponWorld = emptyWorld): { projectiles: ProjectileSystem; events: WeaponEvent[] } {
  const eventBus = new WeaponEvents(), events: WeaponEvent[] = [];
  eventBus.on((event) => events.push(event));
  const damage = new DamageSystem(eventBus);
  return { projectiles: new ProjectileSystem(world, damage, new ExplosionSystem(damage, eventBus), eventBus), events };
}

describe("native projectile system", () => {
  it("uses the native id, speed, endpoint movement and muzzle offset", () => {
    const { projectiles, events } = createSystem();
    const owner = createDamageable("owner", { x: 0, y: 0, z: 10 });
    const muzzle = { x: 2, y: 1, z: 12 };
    const id = projectiles.spawn(Gun.Rocket, owner, owner.position, { x: 320, y: 0, z: 10 }, 1, 1234, muzzle, true);

    expect(id).toBe(1234);
    expect(projectiles.activeProjectiles[0].offset).toEqual({ x: 2, y: 1, z: 2 });
    projectiles.updateprojectiles(250, [owner]);
    expect(projectiles.activeProjectiles[0].o).toEqual({ x: 80, y: 0, z: 10 });
    const moved = [...events].reverse().find((event) => event.type === "projectile-moved");
    expect(moved?.type === "projectile-moved" && moved.offsetMillis).toBe(OFFSETMILLIS - 250);
  });

  it("is independent of variable rendering frame partitions", () => {
    const first = createSystem().projectiles, second = createSystem().projectiles;
    const ownerA = createDamageable("a", { x: 0, y: 0, z: 0 });
    const ownerB = createDamageable("b", { x: 0, y: 0, z: 0 });
    first.spawn(Gun.Rocket, ownerA, ownerA.position, { x: 1000, y: 200, z: 50 }, 1, 1);
    second.spawn(Gun.Rocket, ownerB, ownerB.position, { x: 1000, y: 200, z: 50 }, 1, 1);
    first.updateprojectiles(100, [ownerA]);
    for (const elapsed of [7, 11, 3, 29, 50]) second.updateprojectiles(elapsed, [ownerB]);
    expect(second.activeProjectiles[0].o).toEqual(first.activeProjectiles[0].o);
    expect(second.activeProjectiles[0].offsetmillis).toBe(first.activeProjectiles[0].offsetmillis);
  });

  it("clips at the precise world impact and removes its keyed projectile", () => {
    const world: WeaponWorld = { raycast: (origin, _direction, maximum) => maximum >= 5
      ? { position: { x: origin.x + 5, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, distance: 5 } : undefined };
    const { projectiles, events } = createSystem(world);
    const owner = createDamageable("owner", { x: 0, y: 0, z: 0 });
    projectiles.spawn(Gun.Rocket, owner, owner.position, { x: 100, y: 0, z: 0 }, 1, 10);
    projectiles.updateprojectiles(20, [owner]);
    const explosion = events.find((event) => event.type === "explosion");
    expect(explosion?.type === "explosion" && explosion.position.x).toBe(5);
    expect(events.some((event) => event.type === "projectile-removed" && event.key === "owner:3:10")).toBe(true);
    expect(projectiles.activeProjectiles).toHaveLength(0);
  });

  it("matches remote explosions by exact owner, gun and id with concurrent rockets", () => {
    const { projectiles, events } = createSystem();
    const firstOwner = createDamageable("first", { x: 0, y: 0, z: 0 });
    const secondOwner = createDamageable("second", { x: 0, y: 10, z: 0 });
    projectiles.spawn(Gun.Rocket, firstOwner, firstOwner.position, { x: 100, y: 0, z: 0 }, 1, undefined, firstOwner.position,
      false, { local: false, id: 42 });
    projectiles.spawn(Gun.Rocket, secondOwner, secondOwner.position, { x: 100, y: 10, z: 0 }, 1, undefined, secondOwner.position,
      false, { local: false, id: 42 });
    projectiles.updateprojectiles(100, [firstOwner, secondOwner]);
    expect(projectiles.explodeeffects(Gun.Rocket, secondOwner, 42)).toBe(true);
    expect(projectiles.activeProjectiles).toHaveLength(1);
    expect(projectiles.activeProjectiles[0].owner).toBe(firstOwner);
    expect(projectiles.explodeeffects(Gun.Rocket, secondOwner, 42)).toBe(false);
    expect(events.filter((event) => event.type === "explosion")).toHaveLength(1);
  });

  it.each([
    [{ x: 1, y: 0, z: 0 }, 0, 0],
    [{ x: 0, y: 1, z: 0 }, 90, 0],
    [{ x: -1, y: 0, z: 0 }, 180, 0],
    [{ x: 0, y: -1, z: 0 }, 270, 0],
    [{ x: 0, y: 0, z: 1 }, 90, 90],
  ])("derives native rocket orientation for direction %o", (direction, yaw, pitch) => {
    const pose = projectileRenderPose({ o: { x: 0, y: 0, z: 0 }, to: { x: direction.x * 64, y: direction.y * 64,
      z: direction.z * 64 }, dir: direction, offset: { x: 0, y: 0, z: 0 }, offsetmillis: 0 });
    expect((pose.yaw + 360) % 360).toBeCloseTo(yaw);
    expect(pose.pitch).toBeCloseTo(pitch);
    expect(pose.modelPosition).toEqual({ x: direction.x * 3, y: direction.y * 3, z: direction.z * 3 });
  });

  it("keeps fireball, iceball and slimeball in the particle projectile path and grenades in bouncers", () => {
    const { projectiles } = createSystem();
    const owner = createDamageable("owner", { x: 0, y: 0, z: 0 });
    for (const gun of [Gun.Fireball, Gun.Iceball, Gun.Slimeball]) projectiles.spawn(gun, owner, owner.position,
      { x: 100, y: 0, z: 0 }, 1);
    projectiles.spawn(Gun.Grenade, owner, owner.position, { x: 100, y: 0, z: 0 }, 1);
    expect(projectiles.activeProjectiles.map((projectile) => projectile.gun)).toEqual([Gun.Fireball, Gun.Iceball, Gun.Slimeball]);
    expect(projectiles.bouncers.activeCount).toBe(1);
  });

  it("uses the native half projectile speed for ENT_AI monsters", () => {
    const { projectiles } = createSystem();
    const monster = createDamageable("monster", { x: 0, y: 0, z: 0 });
    monster.monster = true;
    projectiles.spawn(Gun.Fireball, monster, monster.position, { x: 100, y: 0, z: 0 }, 1);
    expect(projectiles.activeProjectiles[0].speed).toBe(100);
  });
});
