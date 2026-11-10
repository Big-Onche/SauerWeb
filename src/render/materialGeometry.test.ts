import { describe, expect, it } from "vitest";
import type { MaterialVolume, SauerMap } from "../map/types";
import { generateMaterialGeometry } from "./materialGeometry";

describe("generateMaterialGeometry", () => {
  it("creates dedicated visible and debug-only handlers", () => {
    const batches = generateMaterialGeometry(mapWith([
      volume({ volume: "water" }),
      volume({ volume: "lava", clip: "clip", death: true }),
      volume({ volume: "glass", alpha: true }),
      volume({ clip: "noclip" }),
    ]));

    expect(batches.find((batch) => batch.kind === "water")?.debugOnly).toBe(false);
    expect(batches.find((batch) => batch.kind === "lava")?.debugOnly).toBe(false);
    expect(batches.find((batch) => batch.kind === "glass")?.debugOnly).toBe(false);
    expect(batches.find((batch) => batch.kind === "clip")?.debugOnly).toBe(true);
    expect(batches.find((batch) => batch.kind === "noclip")?.debugOnly).toBe(true);
    expect(batches.find((batch) => batch.kind === "death")?.debugOnly).toBe(true);
    expect(batches.find((batch) => batch.kind === "alpha")?.debugOnly).toBe(true);
  });

  it("removes the shared face between equal adjacent liquid leaves", () => {
    const first = volume({ volume: "water" });
    const second = volume({ volume: "water", origin: { x: 8, y: 0, z: 0 } });
    const [batch] = generateMaterialGeometry(mapWith([first, second]));

    expect(batch.faceCount).toBe(10);
  });
});

function volume(overrides: Partial<MaterialVolume>): MaterialVolume {
  return {
    origin: { x: 0, y: 0, z: 0 },
    size: 8,
    cubeKind: "empty",
    rawMaterial: 0,
    volume: "air",
    volumeIndex: 0,
    clip: "none",
    death: false,
    alpha: false,
    ...overrides,
  };
}

function mapWith(materialVolumes: MaterialVolume[]): SauerMap {
  return {
    name: "synthetic",
    header: { version: 33, headerSize: 40, worldSize: 64, entityCount: 0, pvsCount: 0, lightmapCount: 0, hasBlendmap: false,
      variableCount: 0, vslotCount: 0 },
    variables: [],
    gameType: "fps",
    textureMru: [],
    entities: [],
    entityRegistry: [],
    vslots: [],
    world: [],
    materialVolumes,
    lightmaps: [],
    bytesConsumedThroughOctree: 0,
    bytesConsumed: 0,
  };
}
