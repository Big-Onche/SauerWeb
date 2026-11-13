import { describe, expect, it } from "vitest";
import type { MapEntity } from "../engine/octa";
import { PhysicsSimulation } from "../engine/physics";
import { PhysicsState } from "../engine/physics/types";
import { canpickup, createFpsEntityRegistry, FpsEntities, fpsEntityDefinition, I_BOOST, I_GREENARMOUR, I_HEALTH, I_QUAD,
  I_SHELLS, I_YELLOWARMOUR, pickup, spawntime, type EntityEffect, type FpsEntityCallbacks, type PickupState } from "./entities";

describe("FPS entity registry", () => {
  it("contains every native Sauerbraten FPS entity definition", () => {
    expect(Array.from({ length: 31 }, (_, type) => fpsEntityDefinition(type)?.name)).toEqual([
      "empty", "light", "mapmodel", "playerstart", "envmap", "particles", "sound", "spotlight",
      "shells", "bullets", "rockets", "riflerounds", "grenades", "cartridges", "health", "healthboost", "greenarmour",
      "yellowarmour", "quaddamage", "teleport", "teledest", "monster", "carrot", "jumppad", "base", "respawnpoint", "box", "barrel",
      "platform", "elevator", "flag",
    ]);
  });

  it("names attributes while preserving raw values and orientation", () => {
    const [model, spawn] = createFpsEntityRegistry([entity(2, [135, 17, 4, 9, 1]), entity(3, [270, 2, 0, 0, 0])]);

    expect(model).toMatchObject({
      index: 0,
      typeName: "mapmodel",
      category: "mapmodel",
      mapModelIndex: 17,
      namedAttributes: { yaw: 135, modelIndex: 17, triggerType: 4, triggerTag: 9, attr5: 1 },
      orientation: { yawDegrees: 135 },
    });
    expect(model.attributes).toEqual([135, 17, 4, 9, 1]);
    expect(spawn.orientation?.yawDegrees).toBe(270);
  });

  it("decodes the signed jumppad push direction", () => {
    const [jumpPad] = createFpsEntityRegistry([entity(23, [8, -4, 3, 0, 0])]);

    expect(jumpPad.typeName).toBe("jumppad");
    expect(jumpPad.orientation?.direction).toBeDefined();
    expect(Math.hypot(...Object.values(jumpPad.orientation!.direction!))).toBeCloseTo(1);
  });
});

describe("FPS movement entities", () => {
  it("teleports to the matching tag and redirects horizontal speed when requested", () => {
    const physics = new PhysicsSimulation(), effects: EntityEffect[] = [];
    const entities = new FpsEntities(physics, { effect: (effect) => effects.push(effect) });
    entities.setMap(createFpsEntityRegistry([
      entity(19, [7, 0, 0, 0, 0], { x: 10, y: 20, z: 0 }),
      entity(20, [90, 7, 1, 0, 0], { x: 100, y: 200, z: 0 }),
    ]));
    physics.player.position = { x: 10, y: 20, z: physics.player.eyeHeight };
    physics.player.velocity = { x: 30, y: 40, z: 5 };

    entities.checkitems(1000);

    expect(physics.player.position).toEqual({ x: 100, y: 200, z: physics.player.eyeHeight });
    expect(physics.player.yaw).toBe(90);
    expect(physics.player.velocity.x).toBeCloseTo(-50);
    expect(physics.player.velocity.y).toBeCloseTo(0);
    expect(physics.player.velocity.z).toBe(5);
    expect(effects).toEqual([{ type: "teleport", teleport: 0, teledest: 1 }]);
  });

  it("applies the native signed jumppad vector and 300ms retrigger guard", () => {
    const physics = new PhysicsSimulation(), effects: EntityEffect[] = [];
    const entities = new FpsEntities(physics, { effect: (effect) => effects.push(effect) });
    entities.setMap(createFpsEntityRegistry([entity(23, [8, -4, 255, 0, 0], { x: 1, y: 2, z: 3 })]));
    physics.player.position = { x: 1, y: 2, z: 3 + physics.player.eyeHeight };
    physics.player.falling = { x: 1, y: 2, z: -30 };

    entities.checkitems(1000);
    entities.checkitems(1200);

    expect(physics.player.velocity).toEqual({ x: -10, y: -40, z: 100 });
    expect(physics.player.falling).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.player.physicsState).toBe(PhysicsState.Fall);
    expect(physics.player.timeInAir).toBe(1);
    expect(effects).toEqual([{ type: "jumppad", jumppad: 0 }]);
  });
});

describe("native FPS pickups", () => {
  it("preserves native eligibility rules and stat caps", () => {
    const state = pickupState();
    expect(canpickup(state, I_HEALTH)).toBe(false);
    state.health = 75;
    pickup(state, I_HEALTH);
    expect(state.health).toBe(100);
    state.health = state.maxHealth = 100;
    pickup(state, I_BOOST);
    expect(state).toMatchObject({ health: 150, maxHealth: 150 });
    pickup(state, I_BOOST);
    expect(state).toMatchObject({ health: 200, maxHealth: 200 });

    state.armourType = 2; state.armour = 100;
    expect(canpickup(state, I_GREENARMOUR)).toBe(false);
    state.armour = 99;
    expect(canpickup(state, I_GREENARMOUR)).toBe(true);
    pickup(state, I_GREENARMOUR);
    expect(state).toMatchObject({ armour: 100, armourType: 1 });
    pickup(state, I_YELLOWARMOUR);
    expect(state).toMatchObject({ armour: 200, armourType: 2 });

    state.ammo[1] = 25;
    pickup(state, I_SHELLS);
    expect(state.ammo[1]).toBe(30);
    state.quadMillis = 25_000;
    pickup(state, I_QUAD);
    expect(state.quadMillis).toBe(30_000);
    expect(canpickup(state, I_QUAD)).toBe(false);
  });

  it("uses native player-count respawn timing and delayed initial spawns", () => {
    expect(spawntime(I_SHELLS, 1)).toBe(16_000);
    expect(spawntime(I_SHELLS, 3)).toBe(12_000);
    expect(spawntime(I_SHELLS, 5)).toBe(8_000);
    expect(spawntime(I_GREENARMOUR, 32)).toBe(20_000);
    expect(spawntime(I_BOOST, 1)).toBe(60_000);
    expect(spawntime(I_QUAD, 1)).toBe(70_000);

    const announcements: number[] = [], system = itemSystem([I_SHELLS, I_GREENARMOUR, I_BOOST, I_QUAD],
      { announce: (type) => announcements.push(type) });
    system.spawnitems(false, 1_000, 4);
    expect([0, 1, 2, 3].map((index) => system.isSpawned(index))).toEqual([true, false, false, false]);
    expect(system.updateLocalSpawns(20_999)).toEqual([]);
    expect(system.updateLocalSpawns(21_000)).toEqual([1]);
    system.updateLocalSpawns(51_000);
    expect(announcements).toEqual([I_BOOST]);
    expect(system.updateLocalSpawns(61_000)).toEqual([2]);
    expect(announcements).toEqual([I_BOOST, I_QUAD]);
    expect(system.updateLocalSpawns(71_000)).toEqual([3]);
  });

  it("shares one authoritative item between competing players and bots", () => {
    const system = itemSystem([I_SHELLS]);
    system.spawnitems(false, 0, 4);
    const player = pickupState(), bot = pickupState();

    expect(system.tryLocalPickup(0, player, 1_000, 4)).toBe(true);
    expect(system.tryLocalPickup(0, bot, 1_000, 4)).toBe(false);
    expect(player.ammo[1]).toBe(10);
    expect(bot.ammo[1]).toBe(0);
    expect(system.updateLocalSpawns(12_999)).toEqual([]);
    expect(system.updateLocalSpawns(13_000)).toEqual([0]);
    expect(system.tryLocalPickup(0, bot, 13_000, 4)).toBe(true);
  });

  it("resets availability on map changes and enforces no-items/no-ammo modes", () => {
    const system = itemSystem([I_SHELLS, I_HEALTH]);
    system.spawnitems(false);
    expect(system.isSpawned(0)).toBe(true);
    system.setMap(createFpsEntityRegistry([entity(I_HEALTH, [0, 0, 0, 0, 0])]), 3, true);
    expect(system.isSpawned(0)).toBe(false);
    system.setMap(createFpsEntityRegistry([entity(I_SHELLS, [0, 0, 0, 0, 0]), entity(I_HEALTH, [0, 0, 0, 0, 0])]), 9, true);
    expect([system.isSpawned(0), system.isSpawned(1)]).toEqual([false, true]);
    system.setMap(createFpsEntityRegistry([entity(I_BOOST, [0, 0, 0, 0, 0]), entity(I_QUAD, [0, 0, 0, 0, 0])]), -2, true);
    expect([system.isSpawned(0), system.isSpawned(1)]).toEqual([true, true]);
  });
});

function pickupState(): PickupState {
  return { health: 100, maxHealth: 100, armour: 0, armourType: 0, ammo: new Int32Array(12), quadMillis: 0 };
}

function itemSystem(types: number[], callbacks: FpsEntityCallbacks = {}): FpsEntities {
  const system = new FpsEntities(new PhysicsSimulation(), callbacks);
  system.setMap(createFpsEntityRegistry(types.map((type, index) => entity(type, [0, 0, 0, 0, 0], { x: index * 20, y: 0, z: 0 }))));
  return system;
}

function entity(type: number, attributes: MapEntity["attributes"], position = { x: 1, y: 2, z: 3 }): MapEntity {
  return { position, attributes, type };
}
