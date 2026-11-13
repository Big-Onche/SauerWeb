export type WaterQuality = 0 | 1 | 2 | 3;

export const WATER_QUALITY_LABELS = ["low", "medium", "high", "ultra"] as const;
const WATER_QUALITY_KEY = "sauerweb.water-quality";

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
}

export function waterQualityLabel(quality: number): string {
  return WATER_QUALITY_LABELS[isWaterQuality(quality) ? quality : 2];
}

function isWaterQuality(value: number): value is WaterQuality {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}
