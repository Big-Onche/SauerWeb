import { loadHudSettings, type HudSettings } from "./HudSettings";

export class FpsHud {
  private readonly element: HTMLDivElement;
  private frameRequest = 0;
  private frameCount = 0;
  private sampleStarted = performance.now();

  constructor(container: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "fps-hud";
    this.element.setAttribute("aria-label", "Frames per second");
    this.element.textContent = "-- FPS";
    container.append(this.element);
    this.applySettings(loadHudSettings());
    window.addEventListener("sauerweb-hud-settings-change", this.onSettingsChange as EventListener);
    this.frameRequest = requestAnimationFrame(this.update);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameRequest);
    window.removeEventListener("sauerweb-hud-settings-change", this.onSettingsChange as EventListener);
    this.element.remove();
  }

  private readonly onSettingsChange = (event: CustomEvent<HudSettings>): void => this.applySettings(event.detail);

  private applySettings(settings: HudSettings): void {
    this.element.hidden = !settings.showFps;
  }

  private readonly update = (now: number): void => {
    this.frameCount++;
    const elapsed = now - this.sampleStarted;
    if (elapsed >= 500) {
      this.element.textContent = `${Math.round(this.frameCount * 1000 / elapsed)} FPS`;
      this.frameCount = 0;
      this.sampleStarted = now;
    }
    this.frameRequest = requestAnimationFrame(this.update);
  };
}
