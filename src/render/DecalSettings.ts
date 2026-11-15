export type DecalQuality = 0 | 1 | 2 | 3 | 4;

export interface DecalQualitySettings {
  distance: number;
  maximum: number;
  lifetimeMs: number;
}

export const DECAL_QUALITY_LABELS = ["disabled", "low", "medium", "high", "ultra"] as const;
export const DECAL_QUALITY_CHANGED = "sauerweb-decal-quality-changed";
export const DECAL_QUALITY_SETTINGS: Readonly<Record<DecalQuality, DecalQualitySettings>> = {
  0: { distance: 0, maximum: 0, lifetimeMs: 0 },
  1: { distance: 256, maximum: 128, lifetimeMs: 15_000 },
  2: { distance: 512, maximum: 256, lifetimeMs: 30_000 },
  3: { distance: 768, maximum: 512, lifetimeMs: 45_000 },
  4: { distance: 1024, maximum: 1024, lifetimeMs: 60_000 },
};
const DECAL_QUALITY_KEY = "sauerweb.decal-quality";

export function loadDecalQuality(): DecalQuality {
  try {
    const stored = localStorage.getItem(DECAL_QUALITY_KEY);
    if (stored === null) return 3;
    const value = Number(stored);
    return isDecalQuality(value) ? value : 3;
  } catch {
    return 3;
  }
}

export function saveDecalQuality(quality: DecalQuality): void {
  try {
    localStorage.setItem(DECAL_QUALITY_KEY, String(quality));
  } catch {
    // High quality remains the in-memory default when browser storage is unavailable.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<DecalQuality>(DECAL_QUALITY_CHANGED, { detail: quality }));
}

export function decalQualityLabel(quality: number): string {
  return DECAL_QUALITY_LABELS[isDecalQuality(quality) ? quality : 3];
}

function isDecalQuality(value: number): value is DecalQuality {
  return Number.isInteger(value) && value >= 0 && value <= 4;
}
