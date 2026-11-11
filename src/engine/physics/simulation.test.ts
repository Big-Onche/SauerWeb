import { describe, expect, it } from "vitest";
import { createInputState } from "./input";
import { runReplay, type PhysicsReplay } from "./replay";
import { PhysicsSimulation } from "../physics";

describe("PhysicsSimulation", () => {
  it("is deterministic for an input replay", () => {
    const replay: PhysicsReplay = {
      spawn: { x: 10, y: 20, z: 30 },
      yaw: 90,
      frames: [5, 10, 15, 20, 25, 30].map((nowMilliseconds) => ({
        nowMilliseconds,
        input: { ...createInputState(), forward: true },
      })),
    };
    expect(runReplay(replay)).toEqual(runReplay(replay));
  });

  it("keeps interpolation separate from authoritative position", () => {
    const simulation = new PhysicsSimulation();
    simulation.spawn({ x: 0, y: 0, z: 30 }, 0, 0);
    const rendered = simulation.update(1, createInputState());
    expect(rendered).not.toBe(simulation.player.position);
    expect(rendered.z).toBeGreaterThan(simulation.player.position.z);
  });

  it("restores the exact spawn state", () => {
    const simulation = new PhysicsSimulation();
    simulation.spawn({ x: 1, y: 2, z: 3 }, 45, 0);
    simulation.update(10, createInputState());
    simulation.reset(10);
    expect(simulation.player.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(simulation.player.yaw).toBe(45);
    expect(simulation.player.timeInAir).toBe(0);
  });
});
