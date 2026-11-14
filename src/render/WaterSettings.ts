export type WaterQuality = 0 | 1 | 2 | 3;

export const WATER_QUALITY_LABELS = ["low", "medium", "high", "ultra"] as const;
const WATER_QUALITY_KEY = "sauerweb.water-quality";
export const WATER_QUALITY_CHANGED = "sauerweb-water-quality-changed";

export const WATER_REFLECTION_SIZES: Readonly<Record<WaterQuality, number>> = { 0: 0, 1: 128, 2: 192, 3: 256 };

export function loadWaterQuality(): WaterQuality {
  try {
    const value = Number(localStorage.getItem(WATER_QUALITY_KEY));
    return isWaterQuality(value) ? value : 2;
  } catch {
    return 2;
  }
}

export function saveWaterQuality(quality: WaterQuality): void {
  try {
    localStorage.setItem(WATER_QUALITY_KEY, String(quality));
  } catch {
    // High quality remains the in-memory default when browser storage is unavailable.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<WaterQuality>(WATER_QUALITY_CHANGED, { detail: quality }));
}

export function waterReflectionSize(quality: WaterQuality): number { return WATER_REFLECTION_SIZES[quality]; }

export function waterQualityLabel(quality: number): string {
  return WATER_QUALITY_LABELS[isWaterQuality(quality) ? quality : 2];
}

function isWaterQuality(value: number): value is WaterQuality {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}
