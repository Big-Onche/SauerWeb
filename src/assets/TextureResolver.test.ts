import { describe, expect, it } from "vitest";
import type { SauerMap, VSlot } from "../engine/octa";
import { resolveMapTextures } from "./TextureResolver";
import type { TextureManifest, TextureSlot } from "./types";

const DEFAULT_VSLOT: VSlot = {
  changed: 0, previous: -1, scale: 1, rotation: 0, offset: [0, 0], scroll: [0, 0], layer: 0, alpha: [0.5, 0], color: [1, 1, 1],
};

describe("resolveMapTextures", () => {
  it("uses configuration slots directly for maps without serialized VSlots", () => {
    const slots = [textureSlot(0, "textures/sky.png"), textureSlot(1, "textures/brick.png", { scale: 2 })];
    const map = { vslots: [] } as unknown as SauerMap;
    const manifest = { slots, unsupported: [], sources: [], mapModels: [] } satisfies TextureManifest;

    const resolved = resolveMapTextures(map, manifest);

    expect(resolved).toHaveLength(2);
    expect(resolved[0].diffuseUrl).toBe("/api/packages/textures/sky.png");
    expect(resolved[1].diffuseUrl).toBe("/api/packages/textures/brick.png");
    expect(resolved[1].vslot.scale).toBe(2);
  });
});

function textureSlot(index: number, path: string, vslot: Partial<VSlot> = {}): TextureSlot {
  return {
    index,
    textures: [{ kind: "diffuse", path }],
    vslot: { ...DEFAULT_VSLOT, ...vslot },
    shader: { name: "stdworld", parameters: {} },
    alphaConfigured: false,
  };
}
