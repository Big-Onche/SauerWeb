export const STATIC_CHUNK_SIZES = [32, 64, 128, 256, 512, 1024, 2048, 4096] as const;
export type StaticChunkSize = typeof STATIC_CHUNK_SIZES[number];
export const PARTICLE_BACKENDS = ["auto", "gpu", "cpu"] as const;
export type ParticleBackend = typeof PARTICLE_BACKENDS[number];
export const PARTICLE_QUALITIES = ["low", "medium", "high"] as const;
export type ParticleQuality = typeof PARTICLE_QUALITIES[number];

export const PARTICLE_CAPACITY_LIMITS: Readonly<Record<ParticleQuality, number>> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

export interface EngineSettings {
  staticChunkSize: StaticChunkSize;
  particleBackend: ParticleBackend;
  particleQuality: ParticleQuality;
}

export const DEFAULT_ENGINE_SETTINGS: Readonly<EngineSettings> = {
  staticChunkSize: 2048,
  particleBackend: "auto",
  particleQuality: "high",
};
const STORAGE_KEY = "sauerweb.engine-settings";

export function loadEngineSettings(): EngineSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<EngineSettings> | null;
    return {
      staticChunkSize: sanitizeChunkSize(value?.staticChunkSize),
      particleBackend: sanitizeParticleBackend(value?.particleBackend),
      particleQuality: sanitizeParticleQuality(value?.particleQuality),
    };
  } catch {
    return { ...DEFAULT_ENGINE_SETTINGS };
  }
}

export function saveEngineSettings(settings: EngineSettings): void {
  const sanitized: EngineSettings = {
    staticChunkSize: sanitizeChunkSize(settings.staticChunkSize),
    particleBackend: sanitizeParticleBackend(settings.particleBackend),
    particleQuality: sanitizeParticleQuality(settings.particleQuality),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Rendering settings remain usable when browser storage is unavailable.
  }
}

export function staticChunkSizeLabel(size: StaticChunkSize): string {
  return `${size} world units`;
}

export function particleBackendLabel(backend: ParticleBackend): string {
  return backend === "auto" ? "automatic" : backend.toUpperCase();
}

export function particleQualityLabel(quality: ParticleQuality): string {
  return `${quality} (${PARTICLE_CAPACITY_LIMITS[quality].toLocaleString()} particles/system)`;
}

function sanitizeChunkSize(value: unknown): StaticChunkSize {
  return STATIC_CHUNK_SIZES.includes(value as StaticChunkSize) ? value as StaticChunkSize : DEFAULT_ENGINE_SETTINGS.staticChunkSize;
}

function sanitizeParticleBackend(value: unknown): ParticleBackend {
  return PARTICLE_BACKENDS.includes(value as ParticleBackend) ? value as ParticleBackend : DEFAULT_ENGINE_SETTINGS.particleBackend;
}

function sanitizeParticleQuality(value: unknown): ParticleQuality {
  return PARTICLE_QUALITIES.includes(value as ParticleQuality) ? value as ParticleQuality : DEFAULT_ENGINE_SETTINGS.particleQuality;
}
