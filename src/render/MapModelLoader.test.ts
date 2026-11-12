import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { MapModelResources } from "./MapModelLoader";

describe("MapModelResources", () => {
  it("disposes every owned map-model material and texture exactly once", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const resources = new MapModelResources();
    const material = resources.ownMaterial(new StandardMaterial("mapmodel-material", scene));
    const texture = resources.ownTexture(new Texture(null, scene));
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;

    expect(scene.materials).toContain(material);
    expect(scene.textures).toContain(texture);

    resources.dispose();
    resources.dispose();

    expect(scene.materials).not.toContain(material);
    expect(scene.textures).not.toContain(texture);
    engine.dispose();
  });
});
