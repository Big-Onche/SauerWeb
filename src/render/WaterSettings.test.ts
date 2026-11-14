import { describe, expect, it } from "vitest";
import { waterReflectionSize } from "./WaterSettings";

describe("water reflection quality", () => {
  it("maps each preset to its exact planar render-target size", () => {
    expect([waterReflectionSize(0), waterReflectionSize(1), waterReflectionSize(2), waterReflectionSize(3)]).toEqual([0, 128, 256, 512]);
  });
});
