import { describe, expect, it } from "vitest";
import { MAT_WATER } from "../../engine/material";
import type { Vec3 } from "../../engine/octa";
import { createDamageable } from "./DamageSystem";
import { DamageSystem } from "./DamageSystem";
import { ExplosionSystem } from "./ExplosionSystem";
import type { WeaponWorld, WorldHit } from "./HitscanSystem";
import { BouncerSystem, BouncerType } from "./BouncerSystem";
import { WeaponEvents, type WeaponEvent } from "./WeaponEvents";

function system(world: WeaponWorld): { bouncers: BouncerSystem; events: WeaponEvent[] } {
  const eventBus = new WeaponEvents(), events: WeaponEvent[] = [];
  eventBus.on((event) => events.push(event));
  const damage = new DamageSystem(eventBus);
  return { bouncers: new BouncerSystem(world, new ExplosionSystem(damage, eventBus), eventBus, () => 0), events };
}

const emptyWorld: WeaponWorld = { raycast: () => undefined };

describe("native bouncer physics", () => {
  it("applies the GL upward adjustment, speed, fixed gravity and lifetime", () => {
    const { bouncers } = system(emptyWorld);
    const owner = createDamageable("owner", { x: -100, y: 0, z: 10 });
    const grenade = bouncers.spawnGrenade({ x: 0, y: 0, z: 10 }, { x: 80, y: 0, z: 10 }, owner,
      { nowMilliseconds: 1000 });
    expect(grenade.id).toBe(1000);
    expect(grenade.velocity.x).toBeCloseTo(198.455, 2);
    expect(grenade.velocity.z).toBeCloseTo(24.807, 2);
    bouncers.updatebouncers(100, [owner]);
    expect(grenade.velocity.z).toBeCloseTo(12.807, 3);
    expect(grenade.lifetime).toBe(1400);
  });

  it("is deterministic across variable frame partitions", () => {
    const first = system(emptyWorld).bouncers, second = system(emptyWorld).bouncers;
    const ownerA = createDamageable("a", { x: -100, y: 0, z: 10 });
    const ownerB = createDamageable("b", { x: -100, y: 0, z: 10 });
    const one = first.spawnGrenade({ x: 0, y: 0, z: 10 }, { x: 80, y: 20, z: 20 }, ownerA);
    const two = second.spawnGrenade({ x: 0, y: 0, z: 10 }, { x: 80, y: 20, z: 20 }, ownerB);
    first.updatebouncers(100, [ownerA]);
    for (const elapsed of [7, 11, 3, 29, 50]) second.updatebouncers(elapsed, [ownerB]);
    expect(two.position).toEqual(one.position);
    expect(two.velocity).toEqual(one.velocity);
  });

  it("uses the native reflection and energy-loss formula for a flat-ground bounce", () => {
    const world = planeWorld("z", 0, 1);
    const { bouncers } = system(world);
    const owner = createDamageable("owner", { x: -100, y: 0, z: 5 });
    const debris = bouncers.newbouncer({ x: 0, y: 0, z: 1.51 }, { x: 10, y: 0, z: -8.49 }, owner,
      BouncerType.BNC_BARRELDEBRIS, 1000, 100);
    bouncers.updatebouncers(5, [owner]);
    expect(debris.velocity.z).toBeGreaterThan(0);
    expect(debris.velocity.x).toBeGreaterThan(0);
    expect(debris.velocity.x).toBeLessThan(71);
  });

  it("reflects from walls and supports consecutive bounces", () => {
    const world = planesWorld([{ axis: "x", coordinate: 5, normal: -1 }, { axis: "x", coordinate: -5, normal: 1 }]);
    const { bouncers } = system(world);
    const owner = createDamageable("owner", { x: 0, y: -100, z: 10 });
    const debris = bouncers.newbouncer({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }, owner,
      BouncerType.BNC_DEBRIS, 1000, 100);
    bouncers.updatebouncers(95, [owner]);
    expect(debris.position.x).toBeGreaterThan(-5);
    expect(Math.abs(debris.velocity.x)).toBeLessThan(100);
  });

  it("uses one-sixteenth gravity and native friction in water", () => {
    const waterWorld: WeaponWorld = { raycast: () => undefined, lookupMaterial: () => MAT_WATER };
    const { bouncers } = system(waterWorld);
    const owner = createDamageable("owner", { x: -100, y: 0, z: 10 });
    const grenade = bouncers.newbouncer({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }, owner,
      BouncerType.BNC_GRENADE, 1000, 200);
    bouncers.updatebouncers(5, [owner]);
    expect(grenade.velocity.x).toBeCloseTo(198.75, 5);
    expect(grenade.velocity.z).toBeCloseTo(-0.037265625, 8);
  });

  it("detonates on dynamic players and matches remote explosions by owner plus id", () => {
    const { bouncers, events } = system(emptyWorld);
    const owner = createDamageable("owner", { x: -100, y: 0, z: 10 });
    const otherOwner = createDamageable("other", { x: -100, y: 5, z: 10 });
    const target = createDamageable("target", { x: 8, y: 0, z: 10 });
    bouncers.newbouncer({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }, owner,
      BouncerType.BNC_GRENADE, 1000, 200, { id: 7 });
    bouncers.updatebouncers(40, [owner, target]);
    expect(events.some((event) => event.type === "bouncer-exploded")).toBe(true);
    bouncers.spawnGrenade({ x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 }, owner, { local: false, id: 9 });
    bouncers.spawnGrenade({ x: 0, y: 5, z: 10 }, { x: 10, y: 5, z: 10 }, otherOwner, { local: false, id: 9 });
    expect(bouncers.explodeeffects(owner, 9)).toBe(true);
    const grenades = bouncers.activeBouncers.filter((bouncer) => bouncer.bouncetype === BouncerType.BNC_GRENADE);
    expect(grenades).toHaveLength(1);
    expect(grenades[0].owner).toBe(otherOwner);
  });

  it("cleans up every type and keeps model variants within native limits", () => {
    const { bouncers } = system(emptyWorld);
    const owner = createDamageable("owner", { x: -100, y: 0, z: 10 });
    for (const type of [BouncerType.BNC_GIBS, BouncerType.BNC_DEBRIS, BouncerType.BNC_BARRELDEBRIS]) {
      const value = bouncers.newbouncer({ x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }, owner, type, 100, 20);
      expect(value.variant).toBe(0);
    }
    bouncers.removebouncers(owner);
    expect(bouncers.activeCount).toBe(0);
  });
});

function planeWorld(axis: "x" | "y" | "z", coordinate: number, normal: number): WeaponWorld {
  return planesWorld([{ axis, coordinate, normal }]);
}

function planesWorld(planes: Array<{ axis: "x" | "y" | "z"; coordinate: number; normal: number }>): WeaponWorld {
  return {
    raycast(origin, direction, maximumDistance, radius = 0): WorldHit | undefined {
      let best: WorldHit | undefined;
      for (const plane of planes) {
        const offset = plane.coordinate + plane.normal * radius;
        const denominator = direction[plane.axis];
        if (denominator * plane.normal >= 0) continue;
        const distance = (offset - origin[plane.axis]) / denominator;
        if (distance < 0 || distance > maximumDistance + 1e-9 || best && distance >= best.distance) continue;
        const position: Vec3 = { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance,
          z: origin.z + direction.z * distance };
        best = { position, distance, normal: { x: plane.axis === "x" ? plane.normal : 0,
          y: plane.axis === "y" ? plane.normal : 0, z: plane.axis === "z" ? plane.normal : 0 } };
      }
      return best;
    },
  };
}
