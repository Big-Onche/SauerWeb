export const STATIC_CHUNK_SIZES = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;
export type StaticChunkSize = typeof STATIC_CHUNK_SIZES[number];

export interface EngineSettings {
  staticChunkSize: StaticChunkSize;
}

export const DEFAULT_ENGINE_SETTINGS: Readonly<EngineSettings> = { staticChunkSize: 2048 };
const STORAGE_KEY = "sauerweb.engine-settings";

export function loadEngineSettings(): EngineSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<EngineSettings> | null;
    return { staticChunkSize: sanitizeChunkSize(value?.staticChunkSize) };
  } catch {
    return { ...DEFAULT_ENGINE_SETTINGS };
  }
}

export function saveEngineSettings(settings: EngineSettings): void {
  const sanitized = { staticChunkSize: sanitizeChunkSize(settings.staticChunkSize) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Rendering settings remain usable when browser storage is unavailable.
  }
}

export function staticChunkSizeLabel(size: StaticChunkSize): string {
  return `${size} world units`;
}

function sanitizeChunkSize(value: unknown): StaticChunkSize {
  return STATIC_CHUNK_SIZES.includes(value as StaticChunkSize) ? value as StaticChunkSize : DEFAULT_ENGINE_SETTINGS.staticChunkSize;
}
