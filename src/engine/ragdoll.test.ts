import { describe, expect, it } from "vitest";
import { parseRagdoll, RagdollSimulation } from "./ragdoll";

describe("ragdoll", () => {
  it("parses the native model commands and optional values", () => {
    const skeleton = parseRagdoll(`rdvert 0 0 0\nrdvert 0 0 2 0.5\nrdeye 1\nrdtri 0 1 0\nrdjoint 4 0 0 1\n` +
      `rdlimitdist 0 1 1 3\nrdlimitrot 0 0 30 0 0 0 1\nrdanimjoints 1`);
    expect(skeleton.vertices).toEqual([{ x: 0, y: 0, z: 0, radius: 1 }, { x: 0, y: 0, z: 2, radius: 0.5 }]);
    expect(skeleton.joints[0].vertices).toEqual([0, 1, -1]);
    expect(skeleton.distanceLimits[0]).toEqual({ vertices: [0, 1], minimum: 1, maximum: 3 });
    expect(skeleton.rotationLimits[0].maximumAngle).toBeCloseTo(Math.PI / 6);
    expect(skeleton.eye).toBe(1);
    expect(skeleton.animateJoints).toBe(true);
  });

  it("uses fixed timesteps, gravity, and native distance constraints", () => {
    const skeleton = parseRagdoll("rdvert 0 0 0\nrdvert 0 0 2\nrdlimitdist 0 1 2");
    const simulation = new RagdollSimulation(skeleton, [{ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }], { x: 0, y: 0, z: 0 }, 0);
    simulation.move(20);
    expect(simulation.lastMove).toBe(20);
    expect(simulation.vertices[0].position.y).toBeLessThan(0);
    expect(Math.hypot(simulation.vertices[1].position.x - simulation.vertices[0].position.x,
      simulation.vertices[1].position.y - simulation.vertices[0].position.y,
      simulation.vertices[1].position.z - simulation.vertices[0].position.z)).toBeCloseTo(2, 4);
  });
});
