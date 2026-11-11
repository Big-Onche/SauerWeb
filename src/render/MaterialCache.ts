import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { ResolvedTexture } from "../assets/types";
import type { Lightmap } from "../map/types";
import { DEFAULT_MAP_LIGHTING, sauerColorBytes } from "./MapLighting";

export type SauerSurfaceMode = "opaque" | "alpha-test" | "transparent" | "special";
export type SauerLightmapMode = "ambient" | "bright" | "dark" | "atlas";

export interface SauerMaterialDescriptor {
  surfaceMode: SauerSurfaceMode;
  lightmapMode: SauerLightmapMode;
  lightmapId: number;
  useLightmapAlpha: boolean;
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
const LIGHTMAP_ID_RESERVED = 6;
const DEFAULT_FULLBRIGHT_LEVEL = 128;
const LIGHTMAP_TYPE_MASK = 0x0f;
const LIGHTMAP_BUMPMAP_COLOR = 1;
const LIGHTMAP_BUMPMAP_DIRECTION = 2;

export function describeSauerMaterial(resolved: ResolvedTexture, cubeMaterial: number, lightmapId: number,
                                      useLightmapAlpha = false): SauerMaterialDescriptor {
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
    lightmapMode: lightmapId >= 6
      ? "atlas"
      : lightmapId === 2 || lightmapId === 3 ? "bright" : lightmapId === 4 || lightmapId === 5 ? "dark" : "ambient",
    lightmapId,
    useLightmapAlpha,
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
  private readonly materials = new Map<string, StandardMaterial | ShaderMaterial>();
  private readonly textures = new Map<string, Texture>();
  private readonly lightmapTextures = new Map<number, RawTexture>();
  private neutralDirectionTexture?: RawTexture;

  constructor(private readonly scene: Scene, private readonly lightmaps: Lightmap[] = [],
              private readonly ambient = DEFAULT_MAP_LIGHTING.ambient) {}

  get(descriptor: SauerMaterialDescriptor): StandardMaterial | ShaderMaterial {
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
    this.lightmapTextures.forEach((texture) => texture.dispose());
    this.neutralDirectionTexture?.dispose();
    this.materials.clear();
    this.textures.clear();
    this.lightmapTextures.clear();
    this.neutralDirectionTexture = undefined;
  }

  private createMaterial(descriptor: SauerMaterialDescriptor, index: number): StandardMaterial | ShaderMaterial {
    if (descriptor.normalUrl || descriptor.specularUrl) return this.createBumpMaterial(descriptor, index);
    const material = new StandardMaterial(`map-material-${index}`, this.scene);
    material.diffuseColor = Color3.White();
    material.ambientColor = Color3.Black();
    material.emissiveColor = Color3.White();
    material.specularColor = Color3.Black();
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.alpha = descriptor.alpha;

    const lightmap = this.getLightmapTexture(descriptor.lightmapId);
    if (lightmap) {
      lightmap.coordinatesIndex = 1;
      material.lightmapTexture = lightmap;
      material.useLightmapAsShadowmap = true;
      if (descriptor.useLightmapAlpha) {
        lightmap.hasAlpha = true;
        material.opacityTexture = lightmap;
        material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      }
    }

    if (descriptor.diffuseUrl) {
      material.diffuseTexture = this.getTexture(descriptor.diffuseUrl, descriptor.scroll, descriptor.surfaceMode !== "opaque");
    }
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
    if (descriptor.alphaUrl && !descriptor.useLightmapAlpha) material.opacityTexture = this.getTexture(descriptor.alphaUrl, descriptor.scroll, true);

    if (descriptor.surfaceMode === "alpha-test" && !descriptor.useLightmapAlpha) {
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.5;
      material.useAlphaFromDiffuseTexture = true;
    } else if (descriptor.surfaceMode === "transparent" && !descriptor.useLightmapAlpha) {
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.useAlphaFromDiffuseTexture = true;
      material.needDepthPrePass = true;
    }
    return material;
  }

  private createBumpMaterial(descriptor: SauerMaterialDescriptor, index: number): ShaderMaterial {
    const material = new ShaderMaterial(`map-bump-material-${index}`, this.scene, {
      vertexSource: SAUER_BUMP_VERTEX_SHADER,
      fragmentSource: SAUER_BUMP_FRAGMENT_SHADER,
    }, {
      attributes: ["position", "normal", "tangent", "uv", "uv2", "color"],
      uniforms: ["world", "worldViewProjection", "cameraPosition", "ambientColor", "specularScale", "textureScale", "textureOffset",
        "glowScale", "alpha", "hasNormalMap", "hasSpecular", "hasSpecularMap", "hasGlowMap", "hasOpacityMap", "alphaCutoff", "fogColor",
        "fogStart", "fogEnd"],
      samplers: ["diffuseSampler", "normalSampler", "specularSampler", "lightmapSampler", "directionSampler", "glowSampler", "opacitySampler"],
      needAlphaBlending: descriptor.surfaceMode === "transparent" || descriptor.useLightmapAlpha,
      needAlphaTesting: descriptor.surfaceMode === "alpha-test",
    });
    material.backFaceCulling = false;
    material.alpha = descriptor.alpha;

    const diffuse = descriptor.diffuseUrl
      ? this.getTexture(descriptor.diffuseUrl, descriptor.scroll, descriptor.surfaceMode !== "opaque")
      : undefined;
    const normal = descriptor.normalUrl ? this.getTexture(descriptor.normalUrl, descriptor.scroll, false, true) : undefined;
    const specular = descriptor.specularUrl ? this.getTexture(descriptor.specularUrl, descriptor.scroll, false, true) : undefined;
    const glow = descriptor.glowUrl ? this.getTexture(descriptor.glowUrl, descriptor.scroll) : undefined;
    const opacity = descriptor.alphaUrl && !descriptor.useLightmapAlpha
      ? this.getTexture(descriptor.alphaUrl, descriptor.scroll, true, true)
      : undefined;
    const lightmap = this.getLightmapTexture(descriptor.lightmapId);
    const direction = this.getLightmapDirectionTexture(descriptor.lightmapId) ?? this.getNeutralDirectionTexture();
    if (diffuse) material.setTexture("diffuseSampler", diffuse);
    if (normal) material.setTexture("normalSampler", normal);
    if (specular) material.setTexture("specularSampler", specular);
    if (lightmap) material.setTexture("lightmapSampler", lightmap);
    if (direction) material.setTexture("directionSampler", direction);
    if (glow) material.setTexture("glowSampler", glow);
    if (opacity) material.setTexture("opacitySampler", opacity);
    material.setColor3("ambientColor", Color3.FromInts(...sauerColorBytes(this.ambient)));
    material.setColor3("specularScale", parameterColor(descriptor.shaderParameters.specscale,
      descriptor.specularUrl ? new Color3(6, 6, 6) : Color3.White()));
    material.setColor3("glowScale", parameterColor(descriptor.shaderParameters.glowcolor, Color3.White()));
    material.setFloat("alpha", descriptor.alpha);
    material.setFloat("hasNormalMap", normal ? 1 : 0);
    material.setFloat("hasSpecular", descriptor.shaderName.includes("spec") || specular ? 1 : 0);
    material.setFloat("hasSpecularMap", specular ? 1 : 0);
    material.setFloat("hasGlowMap", glow ? 1 : 0);
    material.setFloat("hasOpacityMap", opacity ? 1 : 0);
    material.setFloat("alphaCutoff", descriptor.surfaceMode === "alpha-test" ? 0.5 : 0);
    material.onBindObservable.add(() => {
      const size = diffuse?.getBaseSize();
      material.setVector2("textureScale", {
        x: size?.width ? 1 / size.width : 1,
        y: size?.height ? 1 / size.height : 1,
      });
      material.setVector2("textureOffset", { x: diffuse?.uOffset ?? 0, y: diffuse?.vOffset ?? 0 });
      const cameraPosition = this.scene.activeCamera?.globalPosition ?? this.scene.activeCamera?.position ?? { x: 0, y: 0, z: 0 };
      material.setVector3("cameraPosition", cameraPosition);
      material.setColor3("fogColor", this.scene.fogColor);
      material.setFloat("fogStart", this.scene.fogEnabled ? this.scene.fogStart : Number.MAX_VALUE);
      material.setFloat("fogEnd", this.scene.fogEnabled ? this.scene.fogEnd : Number.MAX_VALUE);
    });
    if (descriptor.surfaceMode === "transparent" || descriptor.useLightmapAlpha) material.needDepthPrePass = true;
    return material;
  }

  private getTexture(url: string, scroll: [number, number], hasAlpha = false, linear = false): Texture {
    const key = `${url}|${scroll[0]},${scroll[1]}|${hasAlpha ? 1 : 0}|${linear ? 1 : 0}`;
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
    texture.gammaSpace = !linear;
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

  private getLightmapTexture(lightmapId: number): RawTexture | undefined {
    const cached = this.lightmapTextures.get(lightmapId);
    if (cached) return cached;
    const serialized = lightmapId >= LIGHTMAP_ID_RESERVED ? this.lightmaps[lightmapId - LIGHTMAP_ID_RESERVED] : undefined;
    const width = serialized?.width ?? 1;
    const height = serialized?.height ?? 1;
    const bytesPerPixel = serialized?.bytesPerPixel ?? 3;
    const data = serialized?.data ?? this.reservedLightmapColor(lightmapId);
    if (!serialized && lightmapId >= LIGHTMAP_ID_RESERVED) return undefined;
    const format = bytesPerPixel === 4 ? Constants.TEXTUREFORMAT_RGBA : Constants.TEXTUREFORMAT_RGB;
    const texture = new RawTexture(data, width, height, format, this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, false);
    texture.name = serialized ? `sauer-lightmap-${lightmapId - LIGHTMAP_ID_RESERVED}` : `sauer-reserved-lightmap-${lightmapId}`;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.gammaSpace = false;
    this.lightmapTextures.set(lightmapId, texture);
    return texture;
  }

  private getLightmapDirectionTexture(lightmapId: number): RawTexture | undefined {
    const index = lightmapId - LIGHTMAP_ID_RESERVED;
    const color = this.lightmaps[index];
    const direction = this.lightmaps[index + 1];
    if (!color || !direction || (color.type & LIGHTMAP_TYPE_MASK) !== LIGHTMAP_BUMPMAP_COLOR ||
        (direction.type & LIGHTMAP_TYPE_MASK) !== LIGHTMAP_BUMPMAP_DIRECTION) return undefined;
    return this.getLightmapTexture(lightmapId + 1);
  }

  private getNeutralDirectionTexture(): RawTexture {
    if (this.neutralDirectionTexture) return this.neutralDirectionTexture;
    const texture = new RawTexture(new Uint8Array([128, 128, 255]), 1, 1, Constants.TEXTUREFORMAT_RGB, this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, false);
    texture.name = "sauer-neutral-light-direction";
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    texture.gammaSpace = false;
    this.neutralDirectionTexture = texture;
    return texture;
  }

  private reservedLightmapColor(lightmapId: number): Uint8Array {
    if (lightmapId === 4 || lightmapId === 5) return new Uint8Array([0, 0, 0]);
    if (lightmapId === 2 || lightmapId === 3) return new Uint8Array([DEFAULT_FULLBRIGHT_LEVEL, DEFAULT_FULLBRIGHT_LEVEL, DEFAULT_FULLBRIGHT_LEVEL]);
    return new Uint8Array(sauerColorBytes(this.ambient));
  }
}

function parameterColor(parameter: number[] | undefined, fallback: Color3): Color3 {
  return parameter ? new Color3(parameter[0] ?? 1, parameter[1] ?? parameter[0] ?? 1, parameter[2] ?? parameter[0] ?? 1) : fallback;
}

function stableKey(descriptor: SauerMaterialDescriptor): string {
  return JSON.stringify({
    ...descriptor,
    shaderParameters: Object.entries(descriptor.shaderParameters).sort(([left], [right]) => left.localeCompare(right)),
  });
}

const SAUER_BUMP_VERTEX_SHADER = `
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  attribute vec4 tangent;
  attribute vec2 uv;
  attribute vec2 uv2;
  attribute vec4 color;
  uniform mat4 world;
  uniform mat4 worldViewProjection;
  uniform vec3 cameraPosition;
  uniform vec2 textureScale;
  uniform vec2 textureOffset;
  varying vec2 vTextureUV;
  varying vec2 vLightmapUV;
  varying vec3 vCameraDirection;
  varying vec4 vColor;
  varying float vFogDistance;

  void main(void) {
    vec4 worldPosition = world * vec4(position, 1.0);
    vec3 worldNormal = normalize(mat3(world) * normal);
    vec3 worldTangent = normalize(mat3(world) * tangent.xyz);
    vec3 worldBitangent = cross(worldNormal, worldTangent) * tangent.w;
    vec3 cameraVector = cameraPosition - worldPosition.xyz;
    vCameraDirection = vec3(dot(cameraVector, worldTangent), dot(cameraVector, worldBitangent), dot(cameraVector, worldNormal));
    vTextureUV = uv * textureScale + textureOffset;
    vLightmapUV = uv2;
    vColor = color;
    vFogDistance = length(cameraVector);
    gl_Position = worldViewProjection * vec4(position, 1.0);
  }
`;

const SAUER_BUMP_FRAGMENT_SHADER = `
  precision highp float;
  uniform sampler2D diffuseSampler;
  uniform sampler2D normalSampler;
  uniform sampler2D specularSampler;
  uniform sampler2D lightmapSampler;
  uniform sampler2D directionSampler;
  uniform sampler2D glowSampler;
  uniform sampler2D opacitySampler;
  uniform vec3 ambientColor;
  uniform vec3 specularScale;
  uniform vec3 glowScale;
  uniform float alpha;
  uniform float hasNormalMap;
  uniform float hasSpecular;
  uniform float hasSpecularMap;
  uniform float hasGlowMap;
  uniform float hasOpacityMap;
  uniform float alphaCutoff;
  uniform vec3 fogColor;
  uniform float fogStart;
  uniform float fogEnd;
  varying vec2 vTextureUV;
  varying vec2 vLightmapUV;
  varying vec3 vCameraDirection;
  varying vec4 vColor;
  varying float vFogDistance;

  void main(void) {
    vec4 diffuse = texture2D(diffuseSampler, vTextureUV) * vColor;
    vec4 lightmap = texture2D(lightmapSampler, vLightmapUV);
    vec3 bump = hasNormalMap > 0.5 ? texture2D(normalSampler, vTextureUV).rgb * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0);
    vec3 lightDirection = texture2D(directionSampler, vLightmapUV).rgb * 2.0 - 1.0;
    float diffuseFactor = clamp(dot(lightDirection, bump), 0.0, 1.0);
    vec3 bakedLight = max(lightmap.rgb * diffuseFactor, ambientColor);
    vec3 color = diffuse.rgb;
    if (hasSpecular > 0.5) {
      vec3 halfAngle = normalize(normalize(vCameraDirection) + lightDirection);
      float specular = pow(clamp(dot(halfAngle, bump), 0.0, 1.0), 32.0);
      if (hasSpecularMap > 0.5) specular *= dot(texture2D(specularSampler, vTextureUV).rgb, vec3(1.0 / 3.0));
      color += specularScale * specular;
    }
    color *= bakedLight;
    if (hasGlowMap > 0.5) color += texture2D(glowSampler, vTextureUV).rgb * glowScale;
    float outputAlpha = diffuse.a * lightmap.a * alpha;
    if (hasOpacityMap > 0.5) outputAlpha *= texture2D(opacitySampler, vTextureUV).r;
    if (alphaCutoff > 0.0 && outputAlpha < alphaCutoff) discard;
    float fog = clamp((fogEnd - vFogDistance) / max(fogEnd - fogStart, 0.0001), 0.0, 1.0);
    gl_FragColor = vec4(mix(fogColor, color, fog), outputAlpha);
  }
`;
