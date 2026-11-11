import type { MapFogOverrides } from "../assets/types";
import type { SauerMap } from "../engine/octa";
import { expandSauerColor, sauerColorBytes } from "./MapLighting";

export interface MapFog {
  distance: number;
  start: number;
  color: [number, number, number];
  domeColor: [number, number, number];
  domeHeight: number;
  domeMin: number;
  domeMax: number;
  domeCap: boolean;
  domeClip: number;
  domeClouds: boolean;
}

export interface FogDomeGeometry {
  positions: number[];
  indices: number[];
  colors: number[];
}

export const DEFAULT_MAP_FOG = {
  distance: 4000,
  color: 0x8099b3,
  domeColor: 0,
  domeHeight: -0.5,
  domeMin: 0,
  domeMax: 0,
  domeCap: 1,
  domeClip: 1,
  domeClouds: 1,
} as const;

export function resolveMapFog(map: SauerMap, overrides: MapFogOverrides = {}): MapFog {
  const distance = clamp(overrides.distance ?? numericVariable(map, "fog") ?? DEFAULT_MAP_FOG.distance, 16, 1_000_024);
  const packedColor = expandSauerColor(overrides.color ?? numericVariable(map, "fogcolour") ?? DEFAULT_MAP_FOG.color);
  const packedDomeColor = expandSauerColor(overrides.domeColor ?? numericVariable(map, "fogdomecolour") ?? DEFAULT_MAP_FOG.domeColor);
  return {
    distance,
    start: (distance + 64) / 8,
    color: normalizedColor(packedColor),
    domeColor: normalizedColor(packedDomeColor || packedColor),
    domeHeight: clamp(overrides.domeHeight ?? numericVariable(map, "fogdomeheight") ?? DEFAULT_MAP_FOG.domeHeight, -1, 1),
    domeMin: clamp(overrides.domeMin ?? numericVariable(map, "fogdomemin") ?? DEFAULT_MAP_FOG.domeMin, 0, 1),
    domeMax: clamp(overrides.domeMax ?? numericVariable(map, "fogdomemax") ?? DEFAULT_MAP_FOG.domeMax, 0, 1),
    domeCap: (overrides.domeCap ?? numericVariable(map, "fogdomecap") ?? DEFAULT_MAP_FOG.domeCap) !== 0,
    domeClip: clamp(overrides.domeClip ?? numericVariable(map, "fogdomeclip") ?? DEFAULT_MAP_FOG.domeClip, 0, 1),
    domeClouds: (overrides.domeClouds ?? numericVariable(map, "fogdomeclouds") ?? DEFAULT_MAP_FOG.domeClouds) !== 0,
  };
}

export function createFogDomeGeometry(fog: MapFog, farPlane: number, segments = 64, rings = 16): FogDomeGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const clip = fog.domeClip;
  const ringCount = Math.max(1, rings);
  const segmentCount = Math.max(3, segments);
  const minimumAlpha = Math.min(fog.domeMin, fog.domeMax);
  const addVertex = (x: number, sauerY: number, sauerZ: number, alpha: number): number => {
    positions.push(x * farPlane / 2, farPlane * (fog.domeHeight + sauerZ * (1 - fog.domeHeight)) / 2, sauerY * farPlane / 2);
    colors.push(fog.domeColor[0], fog.domeColor[1], fog.domeColor[2], alpha);
    return positions.length / 3 - 1;
  };

  for (let ring = 0; ring <= ringCount; ring++) {
    const z = clip * (1 - ring / ringCount);
    const radius = Math.sqrt(Math.max(0, 1 - z * z));
    const alpha = clip > 0 ? minimumAlpha + (fog.domeMax - minimumAlpha) * (clip - z) / clip : fog.domeMax;
    for (let segment = 0; segment < segmentCount; segment++) {
      const angle = 2 * Math.PI * segment / segmentCount;
      addVertex(Math.cos(angle) * radius, Math.sin(angle) * radius, z, alpha);
    }
  }
  for (let ring = 0; ring < ringCount; ring++) {
    for (let segment = 0; segment < segmentCount; segment++) {
      const next = (segment + 1) % segmentCount;
      const upper = ring * segmentCount + segment;
      const lower = (ring + 1) * segmentCount + segment;
      indices.push(upper, lower, ring * segmentCount + next, ring * segmentCount + next, lower, (ring + 1) * segmentCount + next);
    }
  }
  if (fog.domeCap && fog.domeHeight < 1) {
    const center = addVertex(0, 0, -(1 + fog.domeHeight) / (1 - fog.domeHeight), fog.domeMax);
    const equator = ringCount * segmentCount;
    for (let segment = 0; segment < segmentCount; segment++) {
      indices.push(equator + segment, center, equator + (segment + 1) % segmentCount);
    }
  }
  return { positions, indices, colors };
}

function normalizedColor(value: number): [number, number, number] {
  return sauerColorBytes(value).map((component) => component / 255) as [number, number, number];
}

function numericVariable(map: SauerMap, name: string): number | undefined {
  const variable = map.variables.find((entry) => entry.name.toLowerCase() === name);
  return variable?.type === "integer" || variable?.type === "float" ? variable.value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
