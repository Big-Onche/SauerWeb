import { describe, expect, it } from "vitest";
import type { MaterialVolume, SauerMap } from "../engine/octa";
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

  it("renders water surfaces without submerged bottom faces or shared faces", () => {
    const first = volume({ volume: "water" });
    const second = volume({ volume: "water", origin: { x: 8, y: 0, z: 0 } });
    const [batch] = generateMaterialGeometry(mapWith([first, second]));

    expect(batch.faceCount).toBe(8);
  });

  it("keeps indexed water materials in separate batches", () => {
    const batches = generateMaterialGeometry(mapWith([
      volume({ volume: "water", volumeIndex: 0 }),
      volume({ volume: "water", volumeIndex: 1, origin: { x: 16, y: 0, z: 0 } }),
    ]));

    expect(batches.map((batch) => batch.materialIndex)).toEqual([0, 1]);
  });

  it("tessellates high-quality water tops for vertex waves without changing logical face counts", () => {
    const [low] = generateMaterialGeometry(mapWith([volume({ volume: "water" })]), 0);
    const [ultra] = generateMaterialGeometry(mapWith([volume({ volume: "water" })]), 3);

    expect(low.faceCount).toBe(5);
    expect(low.indices).toHaveLength(30);
    expect(ultra.faceCount).toBe(5);
    expect(ultra.indices).toHaveLength(48);
    expect(ultra.waveData).toHaveLength(ultra.positions.length / 3 * 2);
  });

  it("applies the native inward bias to vertical water polygons", () => {
    const [water] = generateMaterialGeometry(mapWith([volume({ volume: "water" })]), 0);

    expect(water.positions.slice(0, 12).filter((_, index) => index % 3 === 0)).toEqual([0.1, 0.1, 0.1, 0.1]);
    expect(water.positions.slice(12, 24).filter((_, index) => index % 3 === 0)).toEqual([7.9, 7.9, 7.9, 7.9]);
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
