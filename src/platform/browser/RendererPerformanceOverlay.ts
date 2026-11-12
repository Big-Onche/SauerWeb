import { Engine } from "@babylonjs/core/Engines/engine";
import "@babylonjs/core/Engines/Extensions/engine.query";
import { EngineInstrumentation } from "@babylonjs/core/Instrumentation/engineInstrumentation";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import type { Observable } from "@babylonjs/core/Misc/observable";
import type { Scene } from "@babylonjs/core/scene";

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

const updateIntervalMilliseconds = 500;

export class RendererPerformanceOverlay {
  private readonly element: HTMLPreElement;
  private sceneInstrumentation?: SceneInstrumentation;
  private engineInstrumentation?: EngineInstrumentation;
  private gpuTimingSupported = false;
  private visible = false;
  private sampleStartedAt = 0;
  private frames = 0;
  private frameTimeTotal = 0;
  private cpuFrameTimeTotal = 0;
  private gameLogicTimeTotal = 0;
  private sceneRenderTimeTotal = 0;
  private drawPhaseTimeTotal = 0;
  private drawCallsTotal = 0;
  private gpuFrameTimeTotal = 0;
  private toggleKeyDownHandled = false;

  constructor(parent: HTMLElement, private readonly engine: Engine, private readonly scene: Scene) {
    this.element = document.createElement("pre");
    this.element.className = "renderer-performance-overlay";
    this.element.hidden = true;
    this.element.setAttribute("aria-hidden", "true");
    parent.append(this.element);
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
  }

  recordFrame(gameLogicMilliseconds: number, cpuFrameMilliseconds: number, nowMilliseconds: number): void {
    if (!this.visible || !this.sceneInstrumentation) return;
    this.frames++;
    this.frameTimeTotal += this.engine.getDeltaTime();
    this.cpuFrameTimeTotal += cpuFrameMilliseconds;
    this.gameLogicTimeTotal += gameLogicMilliseconds;
    this.sceneRenderTimeTotal += this.sceneInstrumentation.frameTimeCounter.current;
    this.drawPhaseTimeTotal += this.sceneInstrumentation.renderTimeCounter.current;
    this.drawCallsTotal += this.sceneInstrumentation.drawCallsCounter.current;
    if (this.gpuTimingSupported && this.engineInstrumentation) {
      this.gpuFrameTimeTotal += this.engineInstrumentation.gpuFrameTimeCounter.current * 0.000001;
    }
    if (nowMilliseconds - this.sampleStartedAt >= updateIntervalMilliseconds) this.update(nowMilliseconds);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    this.disable();
    this.element.remove();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!isToggleKey(event) || isEditableTarget(event.target)) return;
    this.toggleKeyDownHandled = true;
    this.handleToggleKey(event);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!isToggleKey(event) || isEditableTarget(event.target)) return;
    if (!this.toggleKeyDownHandled) this.handleToggleKey(event);
    else {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    this.toggleKeyDownHandled = false;
  };

  private handleToggleKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.visible) this.disable();
    else this.enable();
  }

  private enable(): void {
    this.sceneInstrumentation = new SceneInstrumentation(this.scene);
    this.sceneInstrumentation.captureFrameTime = true;
    this.sceneInstrumentation.captureRenderTime = true;
    this.engineInstrumentation = new EngineInstrumentation(this.engine);
    this.gpuTimingSupported = Boolean(this.engine.getCaps().timerQuery);
    if (this.gpuTimingSupported) this.engineInstrumentation.captureGPUFrameTime = true;
    this.visible = true;
    this.element.hidden = false;
    this.resetSamples(performance.now());
    this.element.textContent = "Renderer performance\nCollecting samples…";
  }

  private disable(): void {
    this.visible = false;
    this.element.hidden = true;
    if (this.engineInstrumentation) {
      if (this.engineInstrumentation.captureGPUFrameTime) this.engineInstrumentation.captureGPUFrameTime = false;
      this.engineInstrumentation.dispose();
      this.engineInstrumentation = undefined;
    }
    this.sceneInstrumentation?.dispose();
    this.sceneInstrumentation = undefined;
    this.gpuTimingSupported = false;
  }

  private update(nowMilliseconds: number): void {
    if (!this.frames) return;
    const inverseFrameCount = 1 / this.frames;
    const activeMeshes = this.scene.getActiveMeshes().length;
    const heap = (performance as MemoryPerformance).memory;
    const heapText = heap ? `${formatBytes(heap.usedJSHeapSize)} / ${formatBytes(heap.jsHeapSizeLimit)}` : "N/A";
    const gpuText = this.gpuTimingSupported ? formatMilliseconds(this.gpuFrameTimeTotal * inverseFrameCount) : "N/A";
    const triangles = Math.floor(this.scene.getActiveIndices() / 3);
    const sceneObservers = countSceneObservers(this.scene);
    const engineObservers = countEngineObservers(this.engine);

    this.element.textContent = `Renderer performance · Shift+O to hide
FPS                 ${this.engine.getFps().toFixed(1)}
Frame time          ${formatMilliseconds(this.frameTimeTotal * inverseFrameCount)}
CPU frame time      ${formatMilliseconds(this.cpuFrameTimeTotal * inverseFrameCount)}
Game / physics      ${formatMilliseconds(this.gameLogicTimeTotal * inverseFrameCount)}
Scene render        ${formatMilliseconds(this.sceneRenderTimeTotal * inverseFrameCount)}
Draw phase          ${formatMilliseconds(this.drawPhaseTimeTotal * inverseFrameCount)}
GPU frame time      ${gpuText}
Draw calls          ${Math.round(this.drawCallsTotal * inverseFrameCount).toLocaleString()}
Meshes active/total ${activeMeshes.toLocaleString()} / ${this.scene.meshes.length.toLocaleString()}
Triangles rendered  ${triangles.toLocaleString()}
Vertices rendered   ${this.scene.getTotalVertices().toLocaleString()}
Materials           ${this.scene.materials.length.toLocaleString()}
Textures            ${this.scene.textures.length.toLocaleString()}
Particle systems    ${this.scene.particleSystems.length.toLocaleString()}
Active particles    ${this.scene.getActiveParticles().toLocaleString()}
Lights              ${this.scene.lights.length.toLocaleString()}
JS heap used/limit  ${heapText}
Scene observers     ${sceneObservers.toLocaleString()}
Engine observers    ${engineObservers.toLocaleString()}
Engine              Babylon ${Engine.Version} · ${this.engine.getRenderWidth()}×${this.engine.getRenderHeight()}`;
    this.resetSamples(nowMilliseconds);
  }

  private resetSamples(nowMilliseconds: number): void {
    this.sampleStartedAt = nowMilliseconds;
    this.frames = 0;
    this.frameTimeTotal = 0;
    this.cpuFrameTimeTotal = 0;
    this.gameLogicTimeTotal = 0;
    this.sceneRenderTimeTotal = 0;
    this.drawPhaseTimeTotal = 0;
    this.drawCallsTotal = 0;
    this.gpuFrameTimeTotal = 0;
  }
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function isToggleKey(event: KeyboardEvent): boolean {
  return event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && (event.code === "KeyO" || event.keyCode === 79);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    target instanceof HTMLElement && target.isContentEditable;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function observerCount<Value>(observable: Observable<Value> | undefined): number {
  return observable?.observers.length ?? 0;
}

function countSceneObservers(scene: Scene): number {
  return observerCount(scene.onBeforeRenderObservable) + observerCount(scene.onAfterRenderObservable) +
    observerCount(scene.onBeforeAnimationsObservable) + observerCount(scene.onAfterAnimationsObservable) +
    observerCount(scene.onBeforeDrawPhaseObservable) + observerCount(scene.onAfterDrawPhaseObservable) +
    observerCount(scene.onBeforeCameraRenderObservable) + observerCount(scene.onAfterCameraRenderObservable) +
    observerCount(scene.onBeforeActiveMeshesEvaluationObservable) + observerCount(scene.onAfterActiveMeshesEvaluationObservable) +
    observerCount(scene.onBeforeParticlesRenderingObservable) + observerCount(scene.onAfterParticlesRenderingObservable) +
    observerCount(scene.onDisposeObservable);
}

function countEngineObservers(engine: Engine): number {
  return observerCount(engine.onBeginFrameObservable) + observerCount(engine.onEndFrameObservable) + observerCount(engine.onResizeObservable) +
    observerCount(engine.onContextLostObservable) + observerCount(engine.onContextRestoredObservable) + observerCount(engine.onDisposeObservable);
}
