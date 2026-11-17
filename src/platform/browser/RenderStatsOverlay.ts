import type { Engine } from "@babylonjs/core/Engines/engine";
import type { EngineInstrumentation } from "@babylonjs/core/Instrumentation/engineInstrumentation";
import type { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";

interface MemoryPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

interface RenderInstrumentation {
  readonly engine?: EngineInstrumentation;
  readonly scene?: SceneInstrumentation;
}

export interface StaticRenderStats {
  readonly visibleChunks: number;
  readonly totalChunks: number;
  readonly worldDrawCalls: number;
  readonly mapModelDrawCalls: number;
}

export interface RenderPassSample {
  readonly name: string;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly cpuTime: number;
  readonly drawCpuTime: number;
  readonly meshes: number;
}

interface RenderPassTotal {
  drawCalls: number;
  triangles: number;
  vertices: number;
  cpuTime: number;
  drawCpuTime: number;
  meshes: number;
}

const REFRESH_INTERVAL = 250;

export class RenderStatsOverlay {
  private readonly element: HTMLPreElement;
  private enabled = false;
  private showPasses = false;
  private sampleCount = 0;
  private frameTimeTotal = 0;
  private updateTimeTotal = 0;
  private renderTimeTotal = 0;
  private drawCallTotal = 0;
  private triangleTotal = 0;
  private vertexTotal = 0;
  private lastRefresh = 0;
  private readonly passTotals = new Map<string, RenderPassTotal>();

  constructor(private readonly container: HTMLElement, private readonly engine: Engine, private readonly scene: Scene,
              private readonly instrumentation: () => RenderInstrumentation,
              private readonly visibilityChanged: (visible: boolean) => void,
              private readonly staticStats: () => StaticRenderStats = () => ({
                visibleChunks: 0, totalChunks: 0, worldDrawCalls: 0, mapModelDrawCalls: 0,
              })) {
    this.element = document.createElement("pre");
    this.element.className = "render-stats-overlay";
    this.element.setAttribute("aria-label", "Real-time rendering statistics");
    this.element.hidden = true;
    this.container.append(this.element);
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
  }

  get visible(): boolean {
    return this.enabled;
  }

  get detailed(): boolean {
    return this.enabled && this.showPasses;
  }

  sample(frameTime: number, updateTime: number, renderTime: number, passes: readonly RenderPassSample[]): void {
    if (!this.enabled) return;
    const sceneInstrumentation = this.instrumentation().scene;
    this.sampleCount++;
    this.frameTimeTotal += frameTime;
    this.updateTimeTotal += updateTime;
    this.renderTimeTotal += renderTime;
    this.drawCallTotal += sceneInstrumentation?.drawCallsCounter.current ?? 0;
    this.triangleTotal += Math.floor(this.scene.getActiveIndices() / 3);
    this.vertexTotal += this.scene.getActiveIndices();
    if (this.showPasses) for (const pass of passes) {
      let total = this.passTotals.get(pass.name);
      if (!total) {
        total = { drawCalls: 0, triangles: 0, vertices: 0, cpuTime: 0, drawCpuTime: 0, meshes: 0 };
        this.passTotals.set(pass.name, total);
      }
      total.drawCalls += pass.drawCalls;
      total.triangles += pass.triangles;
      total.vertices += pass.vertices;
      total.cpuTime += pass.cpuTime;
      total.drawCpuTime += pass.drawCpuTime;
      total.meshes += pass.meshes;
    }

    const now = performance.now();
    if (now - this.lastRefresh >= REFRESH_INTERVAL) this.refresh(now);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    if (this.enabled) this.visibilityChanged(false);
    this.element.remove();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "KeyO" || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat || isEditable(event.target)) return;
    event.preventDefault();
    if (event.altKey && this.enabled) {
      this.showPasses = !this.showPasses;
      this.resetSamples(performance.now() - REFRESH_INTERVAL);
      return;
    }
    if (event.altKey) return;
    this.enabled = !this.enabled;
    if (!this.enabled) this.showPasses = false;
    this.visibilityChanged(this.enabled);
    this.element.hidden = !this.enabled;
    this.resetSamples(performance.now() - REFRESH_INTERVAL);
  };

  private refresh(now: number): void {
    if (!this.sampleCount) return;
    const instrumentation = this.instrumentation();
    const activeMeshes = this.scene.getActiveMeshes().length;
    const activeResources = this.activeResources();
    const staticStats = this.staticStats();
    const gpuNanoseconds = instrumentation.engine?.captureGPUFrameTime
      ? instrumentation.engine.gpuFrameTimeCounter.lastSecAverage || instrumentation.engine.gpuFrameTimeCounter.current
      : 0;
    const heapBytes = (performance as MemoryPerformance).memory?.usedJSHeapSize;
    const average = (total: number): number => total / this.sampleCount;
    const passBreakdown = this.showPasses ? this.formatPassBreakdown() : "";
    this.element.textContent = `SAUERWEB | RENDER STATS
FPS              ${this.engine.getFps().toFixed(0)}
Frame            ${formatMilliseconds(average(this.frameTimeTotal))}
CPU Update       ${formatMilliseconds(average(this.updateTimeTotal))}
CPU Render       ${formatMilliseconds(average(this.renderTimeTotal))}
GPU              ${gpuNanoseconds > 0 ? formatMilliseconds(gpuNanoseconds * 0.000001) : "N/A"}

Draw Calls       ${formatCount(average(this.drawCallTotal))}
Triangles        ${formatCount(average(this.triangleTotal))}
Vertices         ${formatCount(average(this.vertexTotal))}
Meshes           ${formatCount(activeMeshes)} / ${formatCount(this.scene.meshes.length)}
Materials        ${formatCount(activeResources.materials)}
Textures         ${formatCount(activeResources.textures)}
Static Chunks    ${formatCount(staticStats.visibleChunks)} / ${formatCount(staticStats.totalChunks)}
World Draws      ${formatCount(staticStats.worldDrawCalls)}
Mapmodel Draws   ${formatCount(staticStats.mapModelDrawCalls)}

JS Heap          ${heapBytes === undefined ? "N/A" : `${(heapBytes / (1024 * 1024)).toFixed(0)} MB`}${passBreakdown}`;
    this.resetSamples(now);
  }

  private formatPassBreakdown(): string {
    let result = "\n\nPASS           DRAWS     TRI   PREP   DRAW  MESHES";
    for (const [name, total] of this.passTotals) {
      const average = (value: number): number => value / this.sampleCount;
      if (name !== "Main" && total.drawCalls === 0 && total.triangles === 0 && total.cpuTime === 0 && total.meshes === 0) continue;
      const prepare = Math.max(0, average(total.cpuTime - total.drawCpuTime));
      result += `\n${name.padEnd(13)}${formatCount(average(total.drawCalls)).padStart(6)}${formatCount(average(total.triangles)).padStart(8)}` +
        `${prepare.toFixed(1).padStart(7)}${average(total.drawCpuTime).toFixed(1).padStart(7)}${formatCount(average(total.meshes)).padStart(8)}`;
    }
    return result;
  }

  private activeResources(): { materials: number; textures: number } {
    const materials = new Set(this.scene.materials.filter((material) => material.hasRenderTargetTextures));
    const textures = new Set<BaseTexture>();
    for (const material of materials) for (const texture of material.getActiveTextures()) textures.add(texture);
    const activeMeshes = this.scene.getActiveMeshes();
    for (let index = 0; index < activeMeshes.length; index++) {
      const material = activeMeshes.data[index].material;
      if (!material || materials.has(material)) continue;
      materials.add(material);
      for (const texture of material.getActiveTextures()) textures.add(texture);
    }
    return { materials: materials.size, textures: textures.size };
  }

  private resetSamples(now: number): void {
    this.sampleCount = 0;
    this.frameTimeTotal = 0;
    this.updateTimeTotal = 0;
    this.renderTimeTotal = 0;
    this.drawCallTotal = 0;
    this.triangleTotal = 0;
    this.vertexTotal = 0;
    for (const total of this.passTotals.values()) {
      total.drawCalls = total.triangles = total.vertices = total.cpuTime = total.drawCpuTime = total.meshes = 0;
    }
    this.lastRefresh = now;
  }
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function formatCount(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (rounded >= 10_000) return `${(rounded / 1_000).toFixed(0)}K`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return rounded.toLocaleString();
}
