import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { ResolvedTexture } from "../assets/types";

export type SauerSurfaceMode = "opaque" | "alpha-test" | "transparent" | "special";
export type SauerLightmapMode = "ambient" | "bright" | "dark" | "atlas";

export interface SauerMaterialDescriptor {
  surfaceMode: SauerSurfaceMode;
  lightmapMode: SauerLightmapMode;
  lightmapId: number;
  shaderName: string;
  shaderParameters: Record<string, number[]>;
  diffuseUrl?: string;
  normalUrl?: string;
  glowUrl?: string;
  specularUrl?: string;
  depthUrl?: string;
  alphaUrl?: string;
  environmentUrl?: string;
  scroll: [number, number];
  alpha: number;
}

const MATF_VOLUME = 7 << 2;
const MAT_WATER = 1 << 2;
const MAT_LAVA = 2 << 2;
const MAT_GLASS = 3 << 2;
const MAT_ALPHA = 4 << 8;

export function describeSauerMaterial(resolved: ResolvedTexture, cubeMaterial: number, lightmapId: number): SauerMaterialDescriptor {
  const shaderName = resolved.slot.shader?.name.toLowerCase() || "stdworld";
  const shaderParameters = resolved.slot.shader?.parameters ?? {};
  const volume = cubeMaterial & MATF_VOLUME;
  const alphaSurface = (cubeMaterial & MAT_ALPHA) !== 0;
  const transparentVolume = volume === MAT_WATER || volume === MAT_GLASS;
  const specialShader = /(?:parallax|glow|env|decal|pulse)/.test(shaderName);
  let surfaceMode: SauerSurfaceMode = "opaque";
  if (alphaSurface || transparentVolume || resolved.slot.alphaConfigured === true) surfaceMode = "transparent";
  else if (resolved.alphaUrl || shaderName.includes("alpha")) surfaceMode = "alpha-test";
  else if (specialShader || volume === MAT_LAVA) surfaceMode = "special";
  return {
    surfaceMode,
    lightmapMode: lightmapId >= 6 ? "atlas" : lightmapId === 2 || lightmapId === 3 ? "bright" : lightmapId === 4 || lightmapId === 5 ? "dark" : "ambient",
    lightmapId,
    shaderName,
    shaderParameters,
    diffuseUrl: resolved.diffuseUrl,
    normalUrl: resolved.normalUrl,
    glowUrl: resolved.glowUrl,
    specularUrl: resolved.specularUrl,
    depthUrl: resolved.depthUrl,
    alphaUrl: resolved.alphaUrl,
    environmentUrl: resolved.environmentUrl,
    scroll: resolved.vslot.scroll,
    alpha: resolved.slot.alphaConfigured === true ? Math.max(resolved.vslot.alpha[0], resolved.vslot.alpha[1]) : transparentVolume ? 0.65 : 1,
  };
}

export class MaterialCache {
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly textures = new Map<string, Texture>();

  constructor(private readonly scene: Scene) {}

  get(descriptor: SauerMaterialDescriptor): StandardMaterial {
    const key = stableKey(descriptor);
    const cached = this.materials.get(key);
    if (cached) return cached;
    const material = this.createMaterial(descriptor, this.materials.size);
    this.materials.set(key, material);
    return material;
  }

  setWireframe(enabled: boolean): void {
    this.materials.forEach((material) => { material.wireframe = enabled; });
  }

  dispose(): void {
    this.materials.forEach((material) => material.dispose(false, false));
    this.textures.forEach((texture) => texture.dispose());
    this.materials.clear();
    this.textures.clear();
  }

  private createMaterial(descriptor: SauerMaterialDescriptor, index: number): StandardMaterial {
    const material = new StandardMaterial(`map-material-${index}`, this.scene);
    material.diffuseColor = Color3.White();
    material.ambientColor = descriptor.lightmapMode === "dark" ? new Color3(0.2, 0.2, 0.2) : new Color3(0.5, 0.5, 0.5);
    material.emissiveColor = descriptor.lightmapMode === "bright" ? Color3.White() : new Color3(0.15, 0.15, 0.15);
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.backFaceCulling = false;
    material.disableLighting = false;
    material.alpha = descriptor.alpha;

    if (descriptor.diffuseUrl) material.diffuseTexture = this.getTexture(descriptor.diffuseUrl, descriptor.scroll, descriptor.surfaceMode !== "opaque");
    if (descriptor.normalUrl) {
      const bump = this.getTexture(descriptor.normalUrl, descriptor.scroll);
      bump.level = 1;
      if (descriptor.shaderName.includes("parallax")) {
        material.useParallax = true;
        material.useParallaxOcclusion = true;
        material.parallaxScaleBias = descriptor.shaderParameters.parallaxscale?.[0] ?? 0.05;
      }
      material.bumpTexture = bump;
    }
    if (descriptor.glowUrl) {
      material.emissiveTexture = this.getTexture(descriptor.glowUrl, descriptor.scroll);
      material.emissiveColor = parameterColor(descriptor.shaderParameters.glowcolor, Color3.White());
    }
    if (descriptor.specularUrl) {
      material.specularTexture = this.getTexture(descriptor.specularUrl, descriptor.scroll);
      material.specularColor = parameterColor(descriptor.shaderParameters.specscale, Color3.White());
    }
    if (descriptor.alphaUrl) material.opacityTexture = this.getTexture(descriptor.alphaUrl, descriptor.scroll, true);

    if (descriptor.surfaceMode === "alpha-test") {
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.5;
      material.useAlphaFromDiffuseTexture = true;
    } else if (descriptor.surfaceMode === "transparent") {
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.useAlphaFromDiffuseTexture = true;
      material.needDepthPrePass = true;
    }
    return material;
  }

  private getTexture(url: string, scroll: [number, number], hasAlpha = false): Texture {
    const key = `${url}|${scroll[0]},${scroll[1]}|${hasAlpha ? 1 : 0}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const texture = new Texture(url, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      const size = texture.getBaseSize();
      texture.uScale = size.width > 0 ? 1 / size.width : 1;
      texture.vScale = size.height > 0 ? 1 / size.height : 1;
    });
    texture.name = `map-texture-${this.textures.size}`;
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.hasAlpha = hasAlpha;
    if (scroll[0] !== 0 || scroll[1] !== 0) {
      const started = performance.now();
      this.scene.onBeforeRenderObservable.add(() => {
        const elapsed = performance.now() - started;
        texture.uOffset = scroll[0] * elapsed;
        texture.vOffset = scroll[1] * elapsed;
      });
    }
    this.textures.set(key, texture);
    return texture;
  }
}

function parameterColor(parameter: number[] | undefined, fallback: Color3): Color3 {
  return parameter ? new Color3(parameter[0] ?? 1, parameter[1] ?? parameter[0] ?? 1, parameter[2] ?? parameter[0] ?? 1) : fallback;
}

function stableKey(descriptor: SauerMaterialDescriptor): string {
  return JSON.stringify({ ...descriptor, shaderParameters: Object.entries(descriptor.shaderParameters).sort(([left], [right]) => left.localeCompare(right)) });
}
