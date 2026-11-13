// Original: src/engine/world.h
export const MAPVERSION = 33;
export const MINIMUM_MAP_VERSION = 27;

export function isSupportedMapVersion(version: number | null): version is number {
  return version !== null && version >= MINIMUM_MAP_VERSION && version <= MAPVERSION;
}
