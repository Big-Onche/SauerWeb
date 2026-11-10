import { describe, expect, it } from "vitest";
import type { OctreeCube } from "./types";
import { collectMaterialVolumes, MAT_ALPHA, MAT_DEATH, MAT_GAMECLIP, MAT_LAVA, MAT_NOCLIP, MAT_WATER } from "./materials";

describe("collectMaterialVolumes", () => {
  it("keeps combined engine flags and bounds in a physics-facing record", () => {
    const cube = materialCube(MAT_LAVA + 2 | MAT_GAMECLIP | MAT_DEATH | MAT_ALPHA);
    const [volume] = collectMaterialVolumes([cube]);

    expect(volume).toMatchObject({
      origin: { x: 8, y: 16, z: 24 },
      size: 8,
      cubeKind: "empty",
      rawMaterial: cube.material,
      volume: "lava",
      volumeIndex: 2,
      clip: "gameclip",
      death: true,
      alpha: true,
    });
  });

  it("retains clip-only and indexed water leaves", () => {
    const volumes = collectMaterialVolumes([materialCube(MAT_NOCLIP), materialCube(MAT_WATER + 3)]);

    expect(volumes.map((volume) => [volume.volume, volume.volumeIndex, volume.clip])).toEqual([
      ["air", 0, "noclip"],
      ["water", 3, "none"],
    ]);
  });
});

function materialCube(material: number): OctreeCube {
  return {
    origin: { x: 8, y: 16, z: 24 },
    size: 8,
    kind: "empty",
    edges: new Uint8Array(12),
    textures: [0, 0, 0, 0, 0, 0],
    material,
    merged: 0,
    surfaces: new Array(6),
  };
}
