import type { MapLightingOverrides } from "../assets/types";
import type { SauerMap } from "../engine/octa";

export interface MapLighting {
  ambient: number;
  skylight: number;
}

export const DEFAULT_MAP_LIGHTING: MapLighting = {
  ambient: 0x191919,
  skylight: 0,
};

export function resolveMapLighting(map: SauerMap, overrides: MapLightingOverrides = {}): MapLighting {
  return {
    ambient: overrides.ambient ?? mapIntegerVariable(map, "ambient") ?? DEFAULT_MAP_LIGHTING.ambient,
    skylight: overrides.skylight ?? mapIntegerVariable(map, "skylight") ?? DEFAULT_MAP_LIGHTING.skylight,
  };
}

export function expandSauerColor(value: number): number {
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(value)));
  return clamped <= 0xff ? clamped * 0x010101 : clamped;
}

export function sauerColorBytes(value: number): [number, number, number] {
  const color = expandSauerColor(value);
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

function mapIntegerVariable(map: SauerMap, name: string): number | undefined {
  const variable = map.variables.find((entry) => entry.name.toLowerCase() === name && entry.type === "integer");
  return variable?.type === "integer" ? variable.value : undefined;
}
