import type { MapWaterOverrides, WaterMaterialOverrides } from "../assets/types";
import type { SauerMap } from "../engine/octa";
import { expandSauerColor, sauerColorBytes } from "./MapLighting";

export interface MapWaterMaterial {
  color: [number, number, number];
  fogDistance: number;
  specular: number;
  waterfallColor: [number, number, number];
}

const DEFAULT_WATER_COLOR = 0x144650;
const DEFAULT_WATER_FOG = 150;
const DEFAULT_WATER_SPECULAR = 150;
export const WATER_OFFSET = 1.1;
export const WATER_AMPLITUDE = 0.4;

export function resolveMapWater(map: SauerMap, overrides: MapWaterOverrides = {}): MapWaterMaterial[] {
  return Array.from({ length: 4 }, (_, index) => {
    const prefix = index === 0 ? "water" : `water${index + 1}`;
    const override = overrides.materials?.[index] ?? {};
    const packedColor = resetDefaultColor(override.color ?? numericVariable(map, `${prefix}colour`) ?? DEFAULT_WATER_COLOR);
    const waterfall = override.waterfallColor ?? numericVariable(map, `${prefix}fallcolour`) ?? 0;
    return {
      color: normalizedColor(packedColor),
      fogDistance: clamp(override.fogDistance ?? numericVariable(map, `${prefix}fog`) ?? DEFAULT_WATER_FOG, 0, 10_000),
      specular: clamp(override.specular ?? numericVariable(map, `${prefix}spec`) ?? DEFAULT_WATER_SPECULAR, 0, 1000),
      waterfallColor: normalizedColor(waterfall || packedColor),
    };
  });
}

export function setWaterOverride(overrides: MapWaterOverrides, index: number, values: WaterMaterialOverrides): void {
  const materials = overrides.materials ??= [];
  materials[index] = { ...materials[index], ...values };
}

export function animatedWaterSurfaceHeight(surfaceZ: number, x: number, y: number, size: number, time: number,
                                           animated: boolean): number {
  if (!animated) return surfaceZ - WATER_OFFSET;
  const waveSize = Math.max(size, 1);
  const localX = positiveModulo(x, waveSize), localY = positiveModulo(y, waveSize);
  const angle = localX * localY * (59 / 23) / (2 * Math.PI);
  let phase = positiveModulo(angle + time / (1.2 * Math.PI), 1) - 0.5;
  phase *= 8 - Math.abs(phase) * 16;
  return surfaceZ - WATER_OFFSET + WATER_AMPLITUDE * phase;
}

export function underwaterFogBlend(surfaceHeight: number, cameraHeight: number): number {
  return clamp(surfaceHeight - cameraHeight, 0, 1);
}

function resetDefaultColor(value: number): number {
  return value === 0 ? DEFAULT_WATER_COLOR : value;
}

function normalizedColor(value: number): [number, number, number] {
  return sauerColorBytes(expandSauerColor(value)).map((component) => srgbToLinear(component / 255)) as [number, number, number];
}

function srgbToLinear(component: number): number {
  return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
}

function numericVariable(map: SauerMap, name: string): number | undefined {
  const variable = map.variables.find((entry) => entry.name.toLowerCase() === name);
  return variable?.type === "integer" || variable?.type === "float" ? variable.value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function positiveModulo(value: number, divisor: number): number {
  return (value % divisor + divisor) % divisor;
}
