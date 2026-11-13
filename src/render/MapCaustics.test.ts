import { describe, expect, it } from "vitest";
import type { SauerMap } from "../engine/octa";
import { buildWaterLookupData, causticFrame, resolveMapCaustics, shouldUseCaustics } from "./MapCaustics";

describe("map caustics", () => {
  it("uses Sauerbraten defaults and reads map variables", () => {
    const map = emptyMap();
    expect(resolveMapCaustics(map)).toEqual({ scale: 50, frameMilliseconds: 75, contrast: 0.6 });

    map.variables.push({ name: "causticscale", type: "integer", value: 25 });
    map.variables.push({ name: "causticmillis", type: "integer", value: 100 });
    map.variables.push({ name: "causticcontrast", type: "float", value: 0.8 });
    expect(resolveMapCaustics(map)).toEqual({ scale: 25, frameMilliseconds: 100, contrast: 0.8 });
  });

  it("cross-fades adjacent frames and wraps the native 32-frame sequence", () => {
    expect(causticFrame(0, 75)).toEqual({ first: 0, second: 1, fraction: 0 });
    expect(causticFrame(112.5, 75)).toEqual({ first: 1, second: 2, fraction: 0.5 });
    expect(causticFrame(31 * 75, 75)).toEqual({ first: 31, second: 0, fraction: 0 });
  });

  it("disables caustics only at low water quality", () => {
    expect(shouldUseCaustics(0)).toBe(false);
    expect([1, 2, 3].every(shouldUseCaustics)).toBe(true);
  });

  it("builds an exact water footprint and vertical range lookup", () => {
    const lookup = buildWaterLookupData(16, [{
      origin: { x: 0, y: 0, z: 0 }, size: 4, cubeKind: "empty", rawMaterial: 1, volume: "water", volumeIndex: 0,
      clip: "none", death: false, alpha: false,
    }, {
      origin: { x: 0, y: 0, z: 4 }, size: 4, cubeKind: "empty", rawMaterial: 1, volume: "water", volumeIndex: 0,
      clip: "none", death: false, alpha: false,
    }]);

    expect(lookup).toMatchObject({ resolution: 4, cellSize: 4 });
    expect(decodeLookup(lookup!.data, 0)).toEqual([0, 8]);
    expect(decodeLookup(lookup!.data, 1)).toEqual([0, 0]);
  });
});

function emptyMap(): SauerMap {
  return {
    name: "caustics", header: { version: 33, headerSize: 40, worldSize: 64, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 }, variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [],
    vslots: [], world: [], materialVolumes: [], lightmaps: [], bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}

function decodeLookup(data: Uint8Array, cell: number): [number, number] {
  const offset = cell * 4;
  return [data[offset] * 256 + data[offset + 1], data[offset + 2] * 256 + data[offset + 3]];
}
