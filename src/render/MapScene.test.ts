import { describe, expect, it } from "vitest";
import { computeTangents } from "./MapScene";

describe("computeTangents", () => {
  it("builds a right-handed tangent frame from world UVs", () => {
    const tangents = computeTangents(
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 0, 1, 0, 0, 1],
      [0, 1, 2],
    );

    expect(tangents).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  });
});
