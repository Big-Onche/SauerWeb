import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadSauerbratenDirectory } from "../../sauerbratenDirectory";
import { generateGeometry } from "./renderva";
import { createInputState } from "./physics/input";
import { PhysicsSimulation } from "./physics";
import { SauerMapParser } from "./worldio";

const sauerbratenDirectory = loadSauerbratenDirectory("test");

describe("SauerMapParser", () => {
  it.each(["aqueducts", "canyon", "cwcastle", "c_egypt", "face-capture", "fanatic_quake", "k_rpg1", "legazzo", "monastery", "nmp4", "oasis",
    "oddworld", "ogrosupply", "pitch_black", "recovery", "relic", "river_c", "rpg_01", "ruine", "sacrifice", "thor"])(
    "decodes bundled v31 map %s and converts its legacy surfaces", (mapName) => {
      const filePath = path.join(sauerbratenDirectory, "packages", "base", `${mapName}.ogz`);
      const bytes = zlib.gunzipSync(fs.readFileSync(filePath));
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const map = new SauerMapParser().parse(buffer, mapName);
      const surfaces = collectSurfaces(map.world);

      expect(map.header.version).toBe(31);
      expect(map.world).toHaveLength(8);
      expect(map.bytesConsumedThroughOctree).toBeLessThanOrEqual(bytes.length);
      expect(map.lightmaps).toHaveLength(map.header.lightmapCount);
      expect(surfaces.length).toBeGreaterThan(0);
      expect(surfaces.every((surface) =>
        surface.vertices.length === (surface.vertexCount & 0x0f) * (surface.vertexCount & 0x80 ? 2 : 1))).toBe(true);
      expect(surfaces.every((surface) => surface.lightmapIds.every((id) => id < 6 || id - 6 < map.lightmaps.length))).toBe(true);
      expect(surfaces.every((surface) => surface.vertices.every((vertex) =>
        vertex.u >= 0 && vertex.u <= 0xffff && vertex.v >= 0 && vertex.v <= 0xffff && vertex.normal >= 0 && vertex.normal <= 65161))).toBe(true);
      expect(map.entities.filter((entity) => entity.type === 2).every((entity) => entity.attributes[0] % 15 === 0)).toBe(true);

      if (mapName === "canyon") {
        const positions = generateGeometry(map).flatMap((batch) => batch.positions);
        let minimum = Number.POSITIVE_INFINITY;
        let maximum = Number.NEGATIVE_INFINITY;
        positions.forEach((coordinate) => {
          minimum = Math.min(minimum, coordinate);
          maximum = Math.max(maximum, coordinate);
        });
        expect(minimum).toBeGreaterThanOrEqual(0);
        expect(maximum).toBeLessThanOrEqual(map.header.worldSize);
      }
    }, 30_000);

  it("decodes a bundled v32 map and converts its legacy materials", () => {
    const filePath = path.join(sauerbratenDirectory, "packages", "base", "asteroids.ogz");
    const bytes = zlib.gunzipSync(fs.readFileSync(filePath));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const map = new SauerMapParser().parse(buffer, "asteroids");

    expect(map.header.version).toBe(32);
    expect(map.world).toHaveLength(8);
    expect(map.bytesConsumedThroughOctree).toBeLessThanOrEqual(bytes.length);
    expect(map.lightmaps).toHaveLength(map.header.lightmapCount);
    expect(map.materialVolumes.length).toBeGreaterThan(0);
    expect(map.materialVolumes.every((volume) => (volume.rawMaterial & ~0x77c) === 0)).toBe(true);
  }, 15_000);

  it.each(["aard3c", "triforts"])("decodes bundled v33 map %s through its octree", (mapName) => {
    const filePath = path.join(sauerbratenDirectory, "packages", "base", `${mapName}.ogz`);
    const bytes = zlib.gunzipSync(fs.readFileSync(filePath));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const map = new SauerMapParser().parse(buffer, mapName);

    expect(map.header.version).toBe(33);
    expect(map.header.worldSize).toBeGreaterThan(0);
    expect(map.world).toHaveLength(8);
    expect(map.bytesConsumedThroughOctree).toBeLessThanOrEqual(bytes.length);
    expect(map.lightmaps).toHaveLength(map.header.lightmapCount);
    expect(map.lightmaps.every((lightmap) => lightmap.width === 512 && lightmap.height === 512)).toBe(true);
    expect(map.bytesConsumed).toBeGreaterThanOrEqual(map.bytesConsumedThroughOctree);
    expect(map.entities.length).toBe(map.header.entityCount);
    expect(map.entityRegistry).toHaveLength(map.entities.length);
    map.entityRegistry.forEach((entity, index) => {
      expect(entity.index).toBe(index);
      expect(entity.position).toEqual(map.entities[index].position);
      expect(entity.attributes).toEqual(map.entities[index].attributes);
      expect(entity.typeName).not.toMatch(/^unknown-/);
    });
    visitSurfaces(map.world, (lightmapId) => {
      expect(lightmapId < 6 || lightmapId - 6 < map.lightmaps.length).toBe(true);
    });

    if (mapName === "aard3c") {
      const positions = generateGeometry(map).flatMap((batch) => batch.positions);
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const coordinate of positions) {
        minimum = Math.min(minimum, coordinate);
        maximum = Math.max(maximum, coordinate);
      }
      expect(minimum).toBeGreaterThanOrEqual(0);
      expect(maximum).toBeLessThanOrEqual(map.header.worldSize);
    }

    const playerStart = map.entities.find((entity) => entity.type === 3);
    expect(playerStart).toBeDefined();
    const simulation = new PhysicsSimulation();
    simulation.setMap(map);
    const spawn = { ...playerStart!.position, z: playerStart!.position.z + simulation.player.eyeHeight };
    simulation.spawn(spawn, playerStart!.attributes[0], 0);
    for (let time = 5; time <= 250; time += 5) simulation.update(time, createInputState());
    const landedHeight = simulation.player.position.z;
    for (let time = 255; time <= 1000; time += 5) simulation.update(time, createInputState());
    expect(simulation.player.position.z).toBeCloseTo(landedHeight, 3);
    expect(simulation.player.position.z).toBeGreaterThan(spawn.z - 8);
  }, 15_000);

  it("rejects non-map data with a descriptive error", () => {
    const bytes = new TextEncoder().encode("not a map");
    expect(() => new SauerMapParser().parse(bytes.buffer)).toThrow(/Unexpected end|Not a Sauerbraten map/);
  });
});

function visitSurfaces(cubes: import("./octa").OctreeCube[], callback: (lightmapId: number) => void): void {
  cubes.forEach((cube) => {
    cube.surfaces.forEach((surface) => surface?.lightmapIds.forEach(callback));
    if (cube.children) visitSurfaces(cube.children, callback);
  });
}

function collectSurfaces(cubes: import("./octa").OctreeCube[]): import("./octa").Surface[] {
  return cubes.flatMap((cube) => [...cube.surfaces.filter((surface): surface is import("./octa").Surface => !!surface),
    ...(cube.children ? collectSurfaces(cube.children) : [])]);
}
