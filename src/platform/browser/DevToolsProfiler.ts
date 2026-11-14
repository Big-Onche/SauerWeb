export type ProfileZone =
  | "frame"
  | "gameUpdate"
  | "playerPhysics"
  | "botUpdate"
  | "weaponSimulation"
  | "entityUpdates"
  | "networking"
  | "hud"
  | "sceneUpdate"
  | "sceneRender"
  | "activeMeshes"
  | "animations"
  | "particles"
  | "drawPhase"
  | "mapGeometry";

export type ProfileCounter = "botAi" | "botPhysics" | "botWeapons" | "playerGeometry" | "raycasts";

type DevToolsColor = "primary" | "primary-light" | "primary-dark" | "secondary" | "secondary-light" | "secondary-dark" |
  "tertiary" | "tertiary-light" | "tertiary-dark" | "error";

interface ZoneDefinition {
  readonly label: string;
  readonly track: string;
  readonly group: string;
  readonly color: DevToolsColor;
}

interface ExtendedConsole {
  timeStamp?(label: string, start?: number, end?: number, track?: string, trackGroup?: string, color?: DevToolsColor): void;
}

const zones: Readonly<Record<ProfileZone, ZoneDefinition>> = {
  frame: { label: "Frame", track: "Main Loop", group: "SauerWeb", color: "primary-dark" },
  gameUpdate: { label: "Game update", track: "Game / Main Loop", group: "SauerWeb", color: "primary" },
  playerPhysics: { label: "Player movement / physics", track: "Physics", group: "SauerWeb", color: "secondary" },
  botUpdate: { label: "Bot AI / physics", track: "Game / Main Loop", group: "SauerWeb", color: "secondary-dark" },
  weaponSimulation: { label: "Weapon simulation", track: "Game / Main Loop", group: "SauerWeb", color: "tertiary" },
  entityUpdates: { label: "Entity updates", track: "Game / Main Loop", group: "SauerWeb", color: "tertiary-light" },
  networking: { label: "Networking / prediction", track: "Networking", group: "SauerWeb", color: "secondary-light" },
  hud: { label: "HUD updates", track: "Game / Main Loop", group: "SauerWeb", color: "primary-light" },
  sceneUpdate: { label: "Scene updates", track: "Rendering CPU", group: "SauerWeb Renderer", color: "primary-light" },
  sceneRender: { label: "Scene render CPU", track: "Rendering CPU", group: "SauerWeb Renderer", color: "primary-dark" },
  activeMeshes: { label: "Mesh evaluation", track: "Babylon.js", group: "SauerWeb Renderer", color: "secondary" },
  animations: { label: "Animation / skeleton updates", track: "Babylon.js", group: "SauerWeb Renderer", color: "secondary-light" },
  particles: { label: "Particle updates", track: "Babylon.js", group: "SauerWeb Renderer", color: "tertiary" },
  drawPhase: { label: "Draw phase", track: "Babylon.js", group: "SauerWeb Renderer", color: "tertiary-dark" },
  mapGeometry: { label: "Map geometry generation", track: "Loading", group: "SauerWeb", color: "primary" },
};

const counterKeys: readonly ProfileCounter[] = ["botAi", "botPhysics", "botWeapons", "playerGeometry", "raycasts"];
const sampleIntervalFrames = 30;
const diagnosticMeasureName = "SauerWeb frame diagnostics";

/** Chrome Performance custom-track integration. It is inert unless the page was opened with `?profile=1`. */
export class DevToolsProfiler {
  readonly enabled: boolean;
  private readonly counters: Record<ProfileCounter, number> = createCounters();
  private raycastCount = 0;
  private sampleFrames = 0;

  constructor(search = globalThis.location?.search ?? "") {
    this.enabled = profileEnabled(search);
  }

  measure<T>(zone: ProfileZone, operation: () => T): T {
    if (!this.enabled) return operation();
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.emit(zone, startedAt, performance.now());
    }
  }

  start(): number {
    return this.enabled ? performance.now() : 0;
  }

  finish(zone: ProfileZone, startedAt: number): void {
    if (this.enabled) this.emit(zone, startedAt, performance.now());
  }

  record(counter: ProfileCounter, milliseconds: number): void {
    if (this.enabled) this.counters[counter] += milliseconds;
  }

  recordRaycast(milliseconds: number): void {
    if (!this.enabled) return;
    this.counters.raycasts += milliseconds;
    this.raycastCount++;
  }

  shouldSampleFrame(): boolean {
    return this.enabled && ++this.sampleFrames >= sampleIntervalFrames;
  }

  sampleFrame(properties: readonly (readonly [string, string])[]): void {
    if (!this.enabled) return;
    const counterProperties: [string, string][] = [
      ["Bot AI CPU", formatMilliseconds(this.counters.botAi)],
      ["Bot physics / collision CPU", formatMilliseconds(this.counters.botPhysics)],
      ["Bot weapon CPU", formatMilliseconds(this.counters.botWeapons)],
      ["Player animation / geometry CPU", formatMilliseconds(this.counters.playerGeometry)],
      ["raycube / rayent CPU", formatMilliseconds(this.counters.raycasts)],
      ["Raycasts", `${(this.raycastCount / sampleIntervalFrames).toFixed(1)} / frame`],
    ];
    for (const property of properties) counterProperties.push([property[0], property[1]]);
    const startedAt = performance.now();
    try {
      performance.measure(diagnosticMeasureName, {
        start: startedAt,
        end: startedAt,
        detail: {
          devtools: {
            dataType: "track-entry",
            track: "Sampled diagnostics",
            trackGroup: "SauerWeb Diagnostics",
            color: "tertiary-light",
            properties: counterProperties,
            tooltipText: "Sampled counters; GPU timing is asynchronous and CPU timings may be nested.",
          },
        },
      });
    } catch {
      // Browsers without measure options still get console.timeStamp zones.
    } finally {
      performance.clearMeasures(diagnosticMeasureName);
      this.resetCounters();
    }
  }

  private emit(zone: ProfileZone, startedAt: number, finishedAt: number): void {
    const definition = zones[zone];
    const timeStamp = (console as unknown as ExtendedConsole).timeStamp;
    timeStamp?.call(console, definition.label, startedAt, finishedAt, definition.track, definition.group, definition.color);
  }

  private resetCounters(): void {
    for (const key of counterKeys) this.counters[key] = 0;
    this.raycastCount = 0;
    this.sampleFrames = 0;
  }
}

export function profileEnabled(search: string): boolean {
  return new URLSearchParams(search).get("profile") === "1";
}

function createCounters(): Record<ProfileCounter, number> {
  return { botAi: 0, botPhysics: 0, botWeapons: 0, playerGeometry: 0, raycasts: 0 };
}

function formatMilliseconds(value: number): string {
  return `${(value / sampleIntervalFrames).toFixed(2)} ms/frame`;
}
