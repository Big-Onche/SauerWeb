export const frameProfileKeys = [
  "playerPhysics", "botAi", "botPhysics", "weaponSimulation", "networking", "playerGeometry", "hud", "particleUpdates", "raycasts",
] as const;

export type FrameProfileKey = typeof frameProfileKeys[number];

export interface FrameProfileSnapshot {
  readonly timings: Readonly<Record<FrameProfileKey, number>>;
  readonly raycastCount: number;
}

/** Low-overhead frame timings. Nested diagnostics are kept separate from exclusive frame phases. */
export class FrameProfiler {
  enabled = false;
  private readonly timings: Record<FrameProfileKey, number> = createTimings();
  private raycastCount = 0;

  measure<T>(key: FrameProfileKey, operation: () => T): T {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.timings[key] += performance.now() - startedAt;
    }
  }

  record(key: FrameProfileKey, milliseconds: number): void {
    if (this.enabled) this.timings[key] += milliseconds;
  }

  recordRaycast(milliseconds: number): void {
    if (!this.enabled) return;
    this.timings.raycasts += milliseconds;
    this.raycastCount++;
  }

  finishFrame(): FrameProfileSnapshot {
    if (!this.enabled) return emptySnapshot;
    const snapshot = { timings: { ...this.timings }, raycastCount: this.raycastCount };
    this.reset();
    return snapshot;
  }

  reset(): void {
    for (const key of frameProfileKeys) this.timings[key] = 0;
    this.raycastCount = 0;
  }
}

const emptySnapshot: FrameProfileSnapshot = { timings: Object.freeze(createTimings()), raycastCount: 0 };

function createTimings(): Record<FrameProfileKey, number> {
  return {
    playerPhysics: 0,
    botAi: 0,
    botPhysics: 0,
    weaponSimulation: 0,
    networking: 0,
    playerGeometry: 0,
    hud: 0,
    particleUpdates: 0,
    raycasts: 0,
  };
}
