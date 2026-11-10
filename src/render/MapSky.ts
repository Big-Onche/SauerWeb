import type { MapSkyOverrides } from "../assets/types";
import type { MapVariable, SauerMap } from "../map/types";

export interface MapSky {
  basePath: string;
  yaw: number;
  spin: number;
  color: [number, number, number];
}

export const DEFAULT_MAP_SKY: MapSky = {
  basePath: "skyboxes/remus/sky01",
  yaw: 0,
  spin: 0,
  color: [1, 1, 1],
};

/** Visual clockwise alignment needed after converting Sauer's Z-up coordinates to Babylon's Y-up cubemap space. */
export const SAUER_SKY_ALIGNMENT_DEGREES = 270;

export function resolveMapSky(map: SauerMap, overrides: MapSkyOverrides = {}): MapSky {
  const packedColor = overrides.color ?? numericVariable(map, "skyboxcolour") ?? 0xffffff;
  return {
    basePath: normalizeSkyPath(overrides.basePath ?? stringVariable(map, "skybox") ?? DEFAULT_MAP_SKY.basePath),
    yaw: overrides.yaw ?? numericVariable(map, "yawsky") ?? DEFAULT_MAP_SKY.yaw,
    spin: overrides.spin ?? numericVariable(map, "spinsky") ?? DEFAULT_MAP_SKY.spin,
    color: packedColorComponents(packedColor),
  };
}

export function skyFaceCandidates(basePath: string, suffix: string): string[] {
  const normalized = normalizeSkyPath(basePath);
  return normalized.includes("*")
    ? [normalized.replace("*", suffix)]
    : [`${normalized}_${suffix}.jpg`, `${normalized}_${suffix}.png`];
}

export function skyTextureRotationRadians(yaw: number, spin: number, elapsedSeconds: number): number {
  // The reflection matrix rotates lookup directions, which is the inverse of rotating the visible sky.
  return (yaw + spin * elapsedSeconds - SAUER_SKY_ALIGNMENT_DEGREES) * Math.PI / 180;
}

function normalizeSkyPath(value: string): string {
  return value.replace(/^<[^>]*>/, "").replaceAll("\\", "/").replace(/^packages\//, "").replace(/^\/+/, "");
}

function packedColorComponents(value: number): [number, number, number] {
  const packed = Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  return [((packed >> 16) & 0xff) / 255, ((packed >> 8) & 0xff) / 255, (packed & 0xff) / 255];
}

function stringVariable(map: SauerMap, name: string): string | undefined {
  const variable = findVariable(map, name);
  return variable?.type === "string" ? variable.value : undefined;
}

function numericVariable(map: SauerMap, name: string): number | undefined {
  const variable = findVariable(map, name);
  return variable?.type === "integer" || variable?.type === "float" ? variable.value : undefined;
}

function findVariable(map: SauerMap, name: string): MapVariable | undefined {
  return map.variables.find((entry) => entry.name.toLowerCase() === name);
}
