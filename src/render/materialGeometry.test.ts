import { describe, expect, it } from "vitest";
import type { MaterialVolume, OctreeCube, SauerMap } from "../engine/octa";
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

  it("clips internal faces shared by differently subdivided water leaves", () => {
    const large = volume({ volume: "water", size: 8 });
    const small = volume({ volume: "water", size: 4, origin: { x: 8, y: 0, z: 0 } });
    const [batch] = generateMaterialGeometry(mapWith([large, small]));

    for (let index = 0; index < batch.indices.length; index += 3) {
      const vertices = batch.indices.slice(index, index + 3).map((vertex) => batch.positions.slice(vertex * 3, vertex * 3 + 3));
      const sharedPlane = vertices.every((vertex) => Math.abs(vertex[0] - 7.9) < 1e-6 || Math.abs(vertex[0] - 8.1) < 1e-6);
      if (!sharedPlane) continue;
      const verticalCenter = vertices.reduce((sum, vertex) => sum + vertex[1], 0) / 3;
      const horizontalCenter = vertices.reduce((sum, vertex) => sum + vertex[2], 0) / 3;
      expect(verticalCenter < 4 && horizontalCenter < 4).toBe(false);
    }
  });

  it("clips water faces covered by coplanar opaque world surfaces", () => {
    const water = volume({ volume: "water" });
    const sideWall = solidCube(8, 0, 0, 8);
    const ceiling = solidCube(0, 0, 8, 8);
    const [batch] = generateMaterialGeometry(mapWith([water], [sideWall, ceiling]));

    expect(batch.faceCount).toBe(3);
    expect(batch.positions.some((_, index) => index % 3 === 0 && Math.abs(batch.positions[index] - 7.9) < 1e-6)).toBe(false);
  });

  it("clips the upper water face beneath a solid even when its underside is not rendered", () => {
    const water = volume({ volume: "water" });
    const ceiling = solidCube(0, 0, 8, 8);
    ceiling.textures[4] = 0;
    const [batch] = generateMaterialGeometry(mapWith([water], [ceiling]));

    expect(batch.faceCount).toBe(4);
    const hasTopTriangle = batch.indices.some((_, index) => index % 3 === 0 && batch.indices.slice(index, index + 3)
      .every((vertex) => Math.abs(batch.positions[vertex * 3 + 1] - 8) < 1e-6));
    expect(hasTopTriangle).toBe(false);
  });

  it("clips the upper water face beneath the solid boundary of a deformed neighbor", () => {
    const water = volume({ volume: "water" });
    const ceiling = solidCube(0, 0, 8, 8);
    ceiling.kind = "normal";
    ceiling.edges.fill(0x40);
    [0, 1, 4, 6].forEach((index) => ceiling.edges[index] = 0x80);
    ceiling.textures[4] = 0;
    const [batch] = generateMaterialGeometry(mapWith([water], [ceiling]));

    expect(batch.faceCount).toBe(4);
  });

  it("does not render a liquid face that is solid on its own octree cube", () => {
    const water = volume({ volume: "water", cubeKind: "normal", solidFaceMask: 1 << 5 });
    const [batch] = generateMaterialGeometry(mapWith([water]));

    expect(batch.faceCount).toBe(4);
    const hasTopTriangle = batch.indices.some((_, index) => index % 3 === 0 && batch.indices.slice(index, index + 3)
      .every((vertex) => Math.abs(batch.positions[vertex * 3 + 1] - 8) < 1e-6));
    expect(hasTopTriangle).toBe(false);
  });

  it("keeps the uncovered part of a water face next to a smaller solid leaf", () => {
    const water = volume({ volume: "water" });
    const partialWall = solidCube(8, 0, 0, 4);
    const [batch] = generateMaterialGeometry(mapWith([water], [partialWall]));
    const sideTriangles = batch.indices.reduce((count, _, index) => {
      if (index % 3) return count;
      const vertices = batch.indices.slice(index, index + 3).map((vertex) => batch.positions.slice(vertex * 3, vertex * 3 + 3));
      return count + (vertices.every((vertex) => Math.abs(vertex[0] - 7.9) < 1e-6) ? 1 : 0);
    }, 0);

    expect(sideTriangles).toBe(4);
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

function solidCube(x: number, y: number, z: number, size: number): OctreeCube {
  return {
    origin: { x, y, z },
    size,
    kind: "solid",
    edges: new Uint8Array(12).fill(0x80),
    textures: [1, 1, 1, 1, 1, 1],
    material: 0,
    merged: 0,
    surfaces: new Array(6),
  };
}

function mapWith(materialVolumes: MaterialVolume[], world: OctreeCube[] = []): SauerMap {
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
    world,
    materialVolumes,
    lightmaps: [],
    bytesConsumedThroughOctree: 0,
    bytesConsumed: 0,
  };
}
