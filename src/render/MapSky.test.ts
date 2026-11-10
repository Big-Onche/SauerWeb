import { describe, expect, it } from "vitest";
import type { SauerMap } from "../map/types";
import { DEFAULT_MAP_SKY, resolveMapSky, skyFaceCandidates, skyTextureRotationRadians } from "./MapSky";

describe("map sky", () => {
  it("resolves defaults, then OGZ variables, then CFG overrides", () => {
    const map = emptyMap();
    expect(resolveMapSky(map)).toEqual(DEFAULT_MAP_SKY);

    map.variables.push({ name: "skybox", type: "string", value: "<compress:2>skyboxes/ogz" });
    map.variables.push({ name: "yawsky", type: "integer", value: 90 });
    map.variables.push({ name: "spinsky", type: "float", value: 0.5 });
    map.variables.push({ name: "skyboxcolour", type: "integer", value: 0x804020 });
    expect(resolveMapSky(map)).toEqual({
      basePath: "skyboxes/ogz", yaw: 90, spin: 0.5, color: [128 / 255, 64 / 255, 32 / 255],
    });
    expect(resolveMapSky(map, { basePath: "packages/skyboxes/cfg", yaw: 180, spin: -1, color: 0xffffff })).toEqual({
      basePath: "skyboxes/cfg", yaw: 180, spin: -1, color: [1, 1, 1],
    });
  });

  it("builds Sauerbraten JPEG/PNG and wildcard face candidates", () => {
    expect(skyFaceCandidates("socksky/mars", "rt")).toEqual(["socksky/mars_rt.jpg", "socksky/mars_rt.png"]);
    expect(skyFaceCandidates("sky/face_*.png", "dn")).toEqual(["sky/face_dn.png"]);
  });

  it("converts the global visual alignment, map yaw, and spin into texture-space rotation", () => {
    expect(skyTextureRotationRadians(0, 0, 0)).toBeCloseTo(-3 * Math.PI / 2);
    expect(skyTextureRotationRadians(90, 0, 0)).toBeCloseTo(-Math.PI);
    expect(skyTextureRotationRadians(245, 0, 0)).toBeCloseTo(-25 * Math.PI / 180);
    expect(skyTextureRotationRadians(30, 2, 5)).toBeCloseTo(-230 * Math.PI / 180);
  });
});

function emptyMap(): SauerMap {
  return {
    name: "test",
    header: {
      version: 33, headerSize: 40, worldSize: 1024, entityCount: 0, pvsCount: 0, lightmapCount: 0, hasBlendmap: false,
      variableCount: 0, vslotCount: 0,
    },
    variables: [],
    gameType: "fps",
    textureMru: [],
    entities: [],
    entityRegistry: [],
    vslots: [],
    world: [],
    materialVolumes: [],
    lightmaps: [],
    bytesConsumedThroughOctree: 0,
    bytesConsumed: 0,
  };
}
