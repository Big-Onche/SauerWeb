import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { MaterialVolume, SauerMap } from "../engine/octa";
import { WATER_OFFSET } from "./MapWater";

export const CAUSTIC_FRAME_COUNT = 32;
export const DEFAULT_CAUSTIC_SCALE = 50;
export const DEFAULT_CAUSTIC_MILLIS = 75;
export const DEFAULT_CAUSTIC_CONTRAST = 0.6;

export interface MapCaustics {
  scale: number;
  frameMilliseconds: number;
  contrast: number;
}

export interface CausticFrame {
  first: number;
  second: number;
  fraction: number;
}

export interface WaterLookupData {
  data: Uint8Array;
  resolution: number;
  cellSize: number;
  heightScale: number;
}

export const CAUSTIC_SHADER_DEFINITIONS = `
uniform sampler2D waterLookupSampler;
uniform sampler2D firstCausticSampler;
uniform sampler2D secondCausticSampler;
uniform vec4 causticLookupInfo;
uniform vec4 causticFrameInfo;
uniform vec4 waterFogColorBlend;
uniform vec2 waterFogRange;

float decodeCausticHeight(vec2 encoded) {
  vec2 bytes = floor(encoded * 255.0 + 0.5);
  return (bytes.x * 256.0 + bytes.y) * causticLookupInfo.w;
}

float causticWaterCell(vec2 cell, float height) {
  if (any(lessThan(cell, vec2(0.0))) || any(greaterThanEqual(cell, vec2(causticLookupInfo.x)))) return 0.0;
  vec2 lookupUv = (cell + vec2(0.5)) / causticLookupInfo.x;
  vec4 water = texture2D(waterLookupSampler, lookupUv);
  float bottom = decodeCausticHeight(water.rg);
  float top = decodeCausticHeight(water.ba);
  return step(0.5, top) * step(bottom - 0.02, height) * step(height, top + 0.02);
}

float mapWaterSubmerged(vec3 worldPosition) {
  // World faces commonly lie exactly on an octree water-cell edge. Sampling a small distance on all four sides keeps floating-point
  // interpolation from alternating between the wet and dry texels and producing an acne-like seam on vertical polygons.
  vec2 lookupPosition = worldPosition.xz / causticLookupInfo.y;
  vec2 seam = vec2(0.01 / causticLookupInfo.y);
  float submerged = causticWaterCell(floor(lookupPosition + vec2(seam.x, seam.y)), worldPosition.y);
  submerged = max(submerged, causticWaterCell(floor(lookupPosition + vec2(seam.x, -seam.y)), worldPosition.y));
  submerged = max(submerged, causticWaterCell(floor(lookupPosition + vec2(-seam.x, seam.y)), worldPosition.y));
  submerged = max(submerged, causticWaterCell(floor(lookupPosition - vec2(seam.x, seam.y)), worldPosition.y));
  return submerged;
}

float mapCausticMultiplier(vec3 worldPosition) {
  float submerged = mapWaterSubmerged(worldPosition);
  vec2 causticUv = vec2(worldPosition.x * 0.011 + worldPosition.y * 0.0066,
    worldPosition.z * 0.011 + worldPosition.y * 0.0066) * causticLookupInfo.z;
  float first = texture2D(firstCausticSampler, causticUv).r;
  float second = texture2D(secondCausticSampler, causticUv).r;
  float pattern = mix(first, second, causticFrameInfo.x);
  return mix(1.0, pattern, causticFrameInfo.y * submerged);
}

vec3 mapApplyWaterFog(vec3 unfogged, vec3 airFogged, vec3 worldPosition, float fogDistance) {
  float range = max(waterFogRange.y - waterFogRange.x, 0.0001);
  float fog = clamp((waterFogRange.y - fogDistance) / range, 0.0, 1.0);
  vec3 waterFogged = mix(waterFogColorBlend.rgb, unfogged, fog);
  return mix(airFogged, waterFogged, mapWaterSubmerged(worldPosition) * waterFogColorBlend.a);
}
`;

export class MapCausticResources {
  readonly lookup: RawTexture;
  readonly frames: Texture[];
  private waterFogColor: [number, number, number] = [0, 0, 0];
  private waterFogStart = 0;
  private waterFogEnd = 1;
  private waterFogBlend = 0;

  constructor(scene: Scene, readonly parameters: MapCaustics, readonly lookupData: WaterLookupData) {
    this.lookup = RawTexture.CreateRGBATexture(lookupData.data, lookupData.resolution, lookupData.resolution, scene, false, false,
      Texture.NEAREST_SAMPLINGMODE);
    this.lookup.name = "map-water-volume-lookup";
    this.lookup.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.lookup.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.lookup.gammaSpace = false;
    this.frames = Array.from({ length: CAUSTIC_FRAME_COUNT }, (_, index) => {
      const frame = index.toString().padStart(2, "0");
      const texture = new Texture(packageAssetUrl(`caustics/caust${frame}.png`) ?? "", scene, false, false,
        Texture.BILINEAR_SAMPLINGMODE);
      texture.wrapU = Texture.WRAP_ADDRESSMODE;
      texture.wrapV = Texture.WRAP_ADDRESSMODE;
      texture.gammaSpace = false;
      return texture;
    });
  }

  bind(effect: Effect): void {
    const frame = causticFrame(performance.now(), this.parameters.frameMilliseconds);
    effect.setTexture("waterLookupSampler", this.lookup);
    effect.setTexture("firstCausticSampler", this.frames[frame.first]);
    effect.setTexture("secondCausticSampler", this.frames[frame.second]);
    effect.setFloat4("causticLookupInfo", this.lookupData.resolution, this.lookupData.cellSize, 100 / this.parameters.scale,
      this.lookupData.heightScale);
    effect.setFloat4("causticFrameInfo", frame.fraction, this.parameters.contrast, 0, 0);
    effect.setFloat4("waterFogColorBlend", ...this.waterFogColor, this.waterFogBlend);
    effect.setFloat2("waterFogRange", this.waterFogStart, this.waterFogEnd);
  }

  setWaterFog(color: [number, number, number], start: number, end: number, blend: number): void {
    this.waterFogColor = color;
    this.waterFogStart = start;
    this.waterFogEnd = end;
    this.waterFogBlend = blend;
  }

  dispose(): void {
    this.lookup.dispose();
    this.frames.forEach((texture) => texture.dispose());
  }
}

export class StandardMaterialCaustics extends MaterialPluginBase {
  constructor(material: StandardMaterial, private readonly resources: MapCausticResources) {
    super(material, "MapCaustics", 130, undefined, true, true);
    this._enable(true);
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("waterLookupSampler", "firstCausticSampler", "secondCausticSampler");
  }

  override getUniforms() {
    return { externalUniforms: ["causticLookupInfo", "causticFrameInfo", "waterFogColorBlend", "waterFogRange"] };
  }

  override bindForSubMesh(_uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    if (subMesh.effect) this.resources.bind(subMesh.effect);
  }

  override getCustomCode(shaderType: string): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: CAUSTIC_SHADER_DEFINITIONS,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: "baseColor.rgb *= mapCausticMultiplier(vPositionW);",
      CUSTOM_FRAGMENT_BEFORE_FOG: "vec3 mapUnfoggedColor = color.rgb;",
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
        #ifdef FOG
          color.rgb = mapApplyWaterFog(mapUnfoggedColor, color.rgb, vPositionW, abs(vFogDistance.z));
        #endif
      `,
    };
  }
}

export function createMapCausticResources(scene: Scene, map: SauerMap): MapCausticResources | undefined {
  const parameters = resolveMapCaustics(map);
  if (parameters.scale <= 0 || parameters.frameMilliseconds <= 0) return undefined;
  const maximumSize = Math.min(2048, scene.getEngine().getCaps().maxTextureSize);
  const lookup = buildWaterLookupData(map.header.worldSize, map.materialVolumes, maximumSize);
  return lookup ? new MapCausticResources(scene, parameters, lookup) : undefined;
}

export function resolveMapCaustics(map: SauerMap): MapCaustics {
  return {
    scale: numericVariable(map, "causticscale", DEFAULT_CAUSTIC_SCALE, 0, 10000),
    frameMilliseconds: numericVariable(map, "causticmillis", DEFAULT_CAUSTIC_MILLIS, 0, 1000),
    contrast: numericVariable(map, "causticcontrast", DEFAULT_CAUSTIC_CONTRAST, 0, 1),
  };
}

export function causticFrame(timeMilliseconds: number, frameMilliseconds: number): CausticFrame {
  const elapsed = Math.max(0, timeMilliseconds);
  const duration = Math.max(1, frameMilliseconds);
  const position = elapsed / duration;
  const first = Math.floor(position) % CAUSTIC_FRAME_COUNT;
  return { first, second: (first + 1) % CAUSTIC_FRAME_COUNT, fraction: position - Math.floor(position) };
}

export function shouldUseCaustics(waterQuality: number): boolean {
  return waterQuality > 0;
}

export function buildWaterLookupData(worldSize: number, materialVolumes: MaterialVolume[], maximumResolution = 2048): WaterLookupData | undefined {
  const water = materialVolumes.filter((volume) => volume.volume === "water");
  if (!water.length) return undefined;
  let cellSize = Math.min(...water.map((volume) => volume.size));
  while (Math.ceil(worldSize / cellSize) > maximumResolution) cellSize *= 2;
  const resolution = Math.ceil(worldSize / cellSize);
  const data = new Uint8Array(resolution * resolution * 4);
  for (const volume of water) {
    const startX = Math.floor(volume.origin.x / cellSize), endX = Math.ceil((volume.origin.x + volume.size) / cellSize);
    const startZ = Math.floor(volume.origin.y / cellSize), endZ = Math.ceil((volume.origin.y + volume.size) / cellSize);
    const bottom = volume.origin.z, top = volume.origin.z + volume.size - WATER_OFFSET;
    for (let z = startZ; z < endZ; z++) for (let x = startX; x < endX; x++) {
      if (x < 0 || z < 0 || x >= resolution || z >= resolution) continue;
      const offset = (z * resolution + x) * 4;
      const existingTop = decodeHeight(data[offset + 2], data[offset + 3], worldSize);
      const existingBottom = decodeHeight(data[offset], data[offset + 1], worldSize);
      encodeHeight(data, offset, existingTop > 0 ? Math.min(existingBottom, bottom) : bottom, worldSize);
      encodeHeight(data, offset + 2, Math.max(existingTop, top), worldSize);
    }
  }
  return { data, resolution, cellSize, heightScale: worldSize / 0xffff };
}

function encodeHeight(data: Uint8Array, offset: number, height: number, worldSize: number): void {
  const value = Math.max(0, Math.min(0xffff, Math.round(height / worldSize * 0xffff)));
  data[offset] = value >>> 8;
  data[offset + 1] = value & 0xff;
}

function decodeHeight(high: number, low: number, worldSize: number): number {
  return (high * 256 + low) / 0xffff * worldSize;
}

function numericVariable(map: SauerMap, name: string, fallback: number, minimum: number, maximum: number): number {
  const variable = map.variables.find((entry) => entry.name.toLowerCase() === name && entry.type !== "string");
  const value = variable?.value;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
