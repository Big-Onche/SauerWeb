import { describe, expect, it } from "vitest";
import { parseRagdoll, poseRagdollVertices, RagdollSimulation } from "./ragdoll";

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

  it("seeds shared particles from the animated model joints", () => {
    const skeleton = parseRagdoll("rdvert 1 0 0\nrdjoint 0 0 0\nrdjoint 1 0 0");
    const bind = [{ position: [0, 0, 0], orientation: [0, 0, 0, 1] } as const,
      { position: [0, 0, 0], orientation: [0, 0, 0, 1] } as const];
    const positions = poseRagdollVertices(skeleton, [{ position: [1, 0, 0], orientation: [0, 0, 0, 1] },
      { position: [3, 0, 0], orientation: [0, 0, 1, 0] }], bind);
    expect(positions[0]).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("applies animation deltas instead of double-transforming model-space particles", () => {
    const skeleton = parseRagdoll("rdvert 5 2 0\nrdjoint 0 0 0");
    const orientation = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
    const bind = [{ position: [10, 3, 0], orientation } as const];
    expect(poseRagdollVertices(skeleton, bind, bind)[0]).toMatchObject({ x: 5, z: 0 });
    expect(poseRagdollVertices(skeleton, bind, bind)[0].y).toBeCloseTo(2);
    const animated = [{ position: [12, 3, 0], orientation } as const];
    expect(poseRagdollVertices(skeleton, animated, bind)[0]).toMatchObject({ x: 7, z: 0 });
    expect(poseRagdollVertices(skeleton, animated, bind)[0].y).toBeCloseTo(2);
  });

  it("sweeps constraint corrections so particles cannot be pulled through geometry", () => {
    const skeleton = parseRagdoll("rdvert 0 0 0 0.5\nrdvert 0 0 0 0.5\nrdlimitdist 0 1 4");
    const collider = (_from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) =>
      to.x < 0 ? { position: { x: 0, y: to.y, z: to.z }, normal: { x: 1, y: 0, z: 0 } } : undefined;
    const simulation = new RagdollSimulation(skeleton, [{ x: 1, y: 1, z: 0 }, { x: 2, y: 1, z: 0 }], { x: 0, y: 0, z: 0 }, 0,
      collider, 1);
    simulation.move(10);
    expect(simulation.vertices[0].position.x).toBeGreaterThanOrEqual(0);
  });

  it("allows particles resting on a surface to move away from it", () => {
    const skeleton = parseRagdoll("rdvert 0 0 0 0.5");
    const collider = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) =>
      to.y < from.y ? { position: from, normal: { x: 0, y: 1, z: 0 } } : undefined;
    const simulation = new RagdollSimulation(skeleton, [{ x: 0, y: 0.5, z: 0 }], { x: 0, y: 20, z: 0 }, 0, collider, 1);
    simulation.move(5);
    expect(simulation.vertices[0].position.y).toBeGreaterThan(0.5);
  });

  it("applies a lethal hit push that arrives after the ragdoll was created", () => {
    const skeleton = parseRagdoll("rdvert 0 0 0 0.5");
    const simulation = new RagdollSimulation(skeleton, [{ x: 0, y: 0, z: 0 }], { x: 0, y: 0, z: 0 }, 0);
    simulation.addVelocity({ x: 80, y: 20, z: 0 });
    simulation.move(5);
    expect(simulation.vertices[0].position.x).toBeGreaterThan(0.39);
    expect(simulation.vertices[0].position.y).toBeGreaterThan(0.09);
  });

});
