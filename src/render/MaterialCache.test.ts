import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { ResolvedTexture } from "../assets/types";
import type { Lightmap } from "../engine/octa";
import { describeSauerMaterial, MaterialCache } from "./MaterialCache";

describe("MaterialCache", () => {
  it("reuses materials with identical Sauer render state", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cache = new MaterialCache(scene);
    const descriptor = describeSauerMaterial(resolvedTexture(), 0, 0);

    expect(cache.get(descriptor)).toBe(cache.get({ ...descriptor }));
    expect(scene.materials).toHaveLength(1);

    cache.dispose();
    engine.dispose();
  });

  it("classifies alpha and aard3c-style parallax/glow surfaces", () => {
    const special = resolvedTexture("bumpspecmapparallaxglowworld");
    expect(describeSauerMaterial(special, 0, 0).surfaceMode).toBe("special");
    expect(describeSauerMaterial(resolvedTexture("alphaworld"), 0, 0).surfaceMode).toBe("alpha-test");
    expect(describeSauerMaterial(special, 4 << 8, 0).surfaceMode).toBe("transparent");
  });

  it("retains lightmap modes independently from Babylon materials", () => {
    const texture = resolvedTexture();
    expect(describeSauerMaterial(texture, 0, 2).lightmapMode).toBe("bright");
    expect(describeSauerMaterial(texture, 0, 4).lightmapMode).toBe("dark");
    expect(describeSauerMaterial(texture, 0, 6).lightmapMode).toBe("atlas");
  });

  it("binds serialized atlases to UV2 and uses atlas alpha for layer blends", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const lightmap: Lightmap = {
      type: 1 << 4,
      bytesPerPixel: 4,
      width: 512,
      height: 512,
      data: new Uint8Array(512 * 512 * 4),
    };
    const cache = new MaterialCache(scene, [lightmap]);
    const material = cache.get(describeSauerMaterial(resolvedTexture(), 0, 6, true));

    expect(material).toBeInstanceOf(StandardMaterial);
    if (!(material instanceof StandardMaterial)) throw new Error("Expected a standard world material.");

    expect(material.lightmapTexture?.coordinatesIndex).toBe(1);
    expect(material.opacityTexture).toBe(material.lightmapTexture);
    expect(material.useLightmapAsShadowmap).toBe(true);

    cache.dispose();
    engine.dispose();
  });

  it("falls back safely when a running dev server returns a legacy manifest", () => {
    const texture = resolvedTexture();
    delete texture.slot.shader;
    delete texture.slot.alphaConfigured;

    expect(describeSauerMaterial(texture, 0, 0)).toMatchObject({ shaderName: "stdworld", surfaceMode: "opaque" });
  });

  it("uses the Sauer bump shader for normal and specular slots", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const texture = resolvedTexture("bumpspecmapworld");
    texture.normalUrl = "/normal.png";
    texture.specularUrl = "/specular.png";
    const cache = new MaterialCache(scene);

    expect(cache.get(describeSauerMaterial(texture, 0, 0))).toBeInstanceOf(ShaderMaterial);

    cache.dispose();
    engine.dispose();
  });

  it("binds the direction atlas paired with a Sauer bump lightmap", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const texture = resolvedTexture("bumpworld");
    texture.normalUrl = "/normal.png";
    const bumpColor = lightmap(1);
    const bumpDirection = lightmap(2);
    const cache = new MaterialCache(scene, [bumpColor, bumpDirection]);
    const material = cache.get(describeSauerMaterial(texture, 0, 6));

    expect(material.getActiveTextures().map((active) => active.name)).toContain("sauer-lightmap-1");

    cache.dispose();
    engine.dispose();
  });
});

function lightmap(type: number): Lightmap {
  return {
    type,
    bytesPerPixel: 3,
    width: 512,
    height: 512,
    data: new Uint8Array(512 * 512 * 3),
  };
}

function resolvedTexture(shaderName = "stdworld"): ResolvedTexture {
  return {
    slot: {
      index: 0,
      textures: [],
      vslot: vslot(),
      shader: { name: shaderName, parameters: {} },
      alphaConfigured: false,
    },
    vslot: vslot(),
  };
}

function vslot() {
  return {
    changed: 0,
    previous: -1,
    scale: 1,
    rotation: 0,
    offset: [0, 0] as [number, number],
    scroll: [0, 0] as [number, number],
    layer: 0,
    alpha: [0.5, 0] as [number, number],
    color: [1, 1, 1] as [number, number, number],
  };
}
