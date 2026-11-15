import { describe, expect, it } from "vitest";
import { PhysicsSimulation } from "../engine/physics";
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
