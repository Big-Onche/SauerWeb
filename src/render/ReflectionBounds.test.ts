import { describe, expect, it } from "vitest";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { expandProjectedBounds, mergeProjectedBounds, projectWorldBounds, projectedBoundsIntersect,
  projectedBoundsToScissor } from "./ReflectionBounds";

describe("reflection projection bounds", () => {
  it("projects a visible box and converts it to a render-target scissor", () => {
    const bounds = projectWorldBounds(new Vector3(-0.5, -0.25, 1), new Vector3(0.5, 0.25, 2), Matrix.Identity());

    expect(bounds).toMatchObject({ minX: -0.5, minY: -0.25, maxX: 0.5, maxY: 0.25, minW: 1 });
    expect(projectedBoundsToScissor(bounds!, 200, 100)).toEqual({ x: 50, y: 37, width: 100, height: 26 });
  });

  it("clips box edges crossing the camera plane conservatively", () => {
    const transform = Matrix.FromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0);
    const bounds = projectWorldBounds(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), transform);

    expect(bounds).toBeDefined();
    expect(bounds!.minX).toBeLessThanOrEqual(-1);
    expect(bounds!.maxX).toBeGreaterThanOrEqual(1);
    expect(projectedBoundsToScissor(bounds!, 128, 128)).toEqual({ x: 0, y: 0, width: 128, height: 128 });
  });

  it("merges, pads, and intersects projected regions", () => {
    const first = { minX: -0.5, minY: -0.5, maxX: 0, maxY: 0, minW: 4 };
    const second = { minX: 0.1, minY: 0.1, maxX: 0.5, maxY: 0.5, minW: 2 };
    const merged = mergeProjectedBounds(first, second);

    expect(merged).toEqual({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5, minW: 2 });
    expect(projectedBoundsIntersect(expandProjectedBounds(merged, 0.1), { minX: 0.55, minY: 0.55, maxX: 0.7, maxY: 0.7, minW: 1 })).toBe(true);
  });
});
