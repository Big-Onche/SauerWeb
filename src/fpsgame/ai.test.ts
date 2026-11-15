import { describe, expect, it } from "vitest";
import { PhysicsSimulation } from "../engine/physics";
import { ClientState } from "../engine/physics/types";
import { normalize, subtract } from "../engine/physics/vector";
import { AiStateType, BotManager, findorientation, type BotActor } from "./ai";
import { createDamageable } from "./weapon/DamageSystem";
import { lineCylinderIntersection } from "./weapon/HitscanSystem";
import { Gun } from "./weapon/WeaponDefinitions";

describe("native bot aiming skill", () => {
  it("fires along the skill-limited current view instead of snapping the shot to the desired target", () => {
    const enemy = createDamageable("enemy", { x: 100, y: 0, z: 14 });
    const low = botAtSkill(1), high = botAtSkill(100);

    turnTowards(low.manager, low.bot, enemy.position, 1000);
    turnTowards(high.manager, high.bot, enemy.position, 1000);

    expect(shotIntersection(low.bot, enemy)).toBeUndefined();
    expect(shotIntersection(high.bot, enemy)).toBeDefined();
    expect(Math.abs(low.bot.yaw - high.bot.yaw)).toBeGreaterThan(45);
  });

  it("applies vanilla weapon-specific aim error inversely proportional to skill", () => {
    const enemy = createDamageable("enemy", { x: 100, y: 0, z: 14 });
    const low = botAtSkill(1, () => 0.999), high = botAtSkill(100, () => 0.999);
    low.bot.selectedGun = high.bot.selectedGun = Gun.Chaingun;

    const lowAim = aimPosition(low.manager, low.bot, enemy, 1000);
    const highAim = aimPosition(high.manager, high.bot, enemy, 1000);
    const lowError = Math.hypot(lowAim.x - enemy.position.x, lowAim.y - enemy.position.y);
    const highError = Math.hypot(highAim.x - enemy.position.x, highAim.y - enemy.position.y);

    expect(lowError).toBeGreaterThan(highError * 90);
  });
});

describe("native bot route following", () => {
  it("advances from the closest route node toward the goal instead of steering back into the node underfoot", () => {
    const { manager, bot } = botAtSkill(100);
    manager.waypoints.clearwaypoints();
    const start = manager.waypoints.addwaypoint({ x: 0, y: 0, z: 0 });
    const current = manager.waypoints.addwaypoint({ x: 10, y: 0, z: 0 });
    const next = manager.waypoints.addwaypoint({ x: 20, y: 0, z: 0 });
    const goal = manager.waypoints.addwaypoint({ x: 30, y: 0, z: 0 });
    manager.waypoints.linkwaypoint(start, current);
    manager.waypoints.linkwaypoint(current, next);
    manager.waypoints.linkwaypoint(next, goal);
    bot.position = { x: 10, y: 0, z: bot.eyeHeight };
    bot.lastNode = current;
    bot.ai.route = [goal, next, current];

    Reflect.apply(Reflect.get(manager, "hunt"), manager, [bot, bot.ai.state[0], 1000]);

    expect(bot.ai.targetNode).toBe(next);
    expect(bot.ai.spot).toEqual(manager.waypoints.waypoints[next].o);
    expect(bot.ai.state[0].type).toBe(AiStateType.Wait);
  });
});

describe("native bot lifecycle", () => {
  it("requests the first spawn for a forced-dead bot even when its initial life sequence is -1", () => {
    const physics = new PhysicsSimulation(), requests: number[] = [];
    const manager = new BotManager(physics, physics.player, { spawnRequest: (bot) => requests.push(bot.clientNumber) });
    const bot = manager.init({ clientNumber: 7, ownerNumber: 4, skill: 50 });
    Object.assign(bot, { lifeSequence: -1, respawned: -2, clientState: ClientState.Dead, alive: false, lastPain: 1000, deadAt: 1000 });

    manager.update(1499, []);
    manager.update(1500, []);
    manager.update(2500, []);

    expect(requests).toEqual([7]);
    expect(bot.respawned).toBe(-1);
  });

  it("uses the native five-second CTF bot wait with its 250 ms allowance", () => {
    const physics = new PhysicsSimulation(), requests: number[] = [];
    const manager = new BotManager(physics, physics.player, { spawnRequest: (bot) => requests.push(bot.clientNumber) });
    manager.setGameMode(11);
    const bot = manager.init({ clientNumber: 7, ownerNumber: 4, skill: 50 });
    Object.assign(bot, { lifeSequence: 2, respawned: -1, clientState: ClientState.Dead, alive: false, lastPain: 1000, deadAt: 1000 });

    manager.update(6249, []);
    expect(requests).toEqual([]);
    manager.update(6250, []);
    expect(requests).toEqual([7]);
  });

  it("routes an owned bot suicide to the server once per native sequence token", () => {
    const physics = new PhysicsSimulation(), requests: number[] = [];
    const manager = new BotManager(physics, physics.player, { suicideRequest: (bot) => requests.push(bot.clientNumber) });
    const bot = manager.init({ clientNumber: 7, ownerNumber: 4, skill: 50 });

    Reflect.apply(Reflect.get(manager, "suicide"), manager, [bot, 6100]);
    Reflect.apply(Reflect.get(manager, "suicide"), manager, [bot, 6200]);
    Reflect.apply(Reflect.get(manager, "suicide"), manager, [bot, 7100]);

    expect(requests).toEqual([7, 7]);
    expect(bot.clientState).toBe(ClientState.Alive);
  });

  it("stops every bot during intermission", () => {
    const { manager, bot } = botAtSkill(50);
    bot.move = bot.strafe = 1;
    bot.jumping = true;
    bot.weaponSystem.controller.setAttacking(true);

    manager.update(1000, [], true, true);

    expect(bot.move).toBe(0);
    expect(bot.strafe).toBe(0);
    expect(bot.jumping).toBe(false);
    expect(bot.weaponSystem.controller.attacking).toBe(false);
  });
});

function botAtSkill(skill: number, random: () => number = () => 0.5): { manager: BotManager; bot: BotActor } {
  const physics = new PhysicsSimulation();
  const manager = new BotManager(physics, physics.player, {}, random);
  const bot = manager.addbot(skill);
  if (!bot) throw new Error("Could not create test bot.");
  bot.position = { x: 0, y: 0, z: 14 };
  bot.yaw = 0;
  bot.pitch = 0;
  bot.ai.lastRun = 984;
  return { manager, bot };
}

function aimPosition(manager: BotManager, bot: BotActor, enemy: ReturnType<typeof createDamageable>, now: number) {
  return Reflect.apply(Reflect.get(manager, "getaimpos"), manager, [bot, enemy, now]) as { x: number; y: number; z: number };
}

function turnTowards(manager: BotManager, bot: BotActor, target: { x: number; y: number; z: number }, now: number): void {
  Reflect.apply(Reflect.get(manager, "turnAndMove"), manager, [bot, target, now, 1.5, false]);
}

function shotIntersection(bot: BotActor, enemy: ReturnType<typeof createDamageable>): number | undefined {
  const target = findorientation(bot.position, bot.yaw, bot.pitch, 100);
  const direction = subtract(target, bot.position);
  normalize(direction);
  return lineCylinderIntersection(bot.position, direction, 100, enemy);
}
