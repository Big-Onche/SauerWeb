import type { WeaponController } from "../../fpsgame/weapon/WeaponController";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";
import { CROSSHAIRS, loadCrosshairSettings, type CrosshairSettings } from "./CrosshairSettings";

export class CrosshairHUD {
  readonly element: HTMLCanvasElement;
  private settings = loadCrosshairSettings();
  private hitUntil = 0;
  private timer = 0;
  private teammateAim = false;
  private image = "";
  private color = "";
  private drawGeneration = 0;

  constructor(parent: HTMLElement, private readonly controller: WeaponController, events: WeaponEvents) {
    this.element = document.createElement("canvas");
    this.element.className = "game-crosshair";
    this.element.setAttribute("aria-hidden", "true");
    parent.append(this.element);
    events.on((event) => this.handle(event));
    window.addEventListener("sauerweb-crosshair-change", this.settingsChanged as EventListener);
    window.addEventListener("resize", this.render);
    this.render();
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    window.removeEventListener("sauerweb-crosshair-change", this.settingsChanged as EventListener);
    window.removeEventListener("resize", this.render);
    this.element.remove();
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }

  update(teammateAim: boolean): void {
    this.teammateAim = teammateAim;
    this.render();
  }

  private handle(event: WeaponEvent): void {
    if (event.type === "shot" && event.hits.length && this.settings.effects && this.settings.hitDuration > 0) {
      this.hitUntil = performance.now() + this.settings.hitDuration;
    }
    this.render();
    window.clearTimeout(this.timer);
    const hitDelay = Math.max(0, this.hitUntil - performance.now());
    const gunDelay = event.type === "shot" ? this.controller.gunWait : 0;
    if (hitDelay > 0 || gunDelay > 0) this.timer = window.setTimeout(this.render, Math.max(hitDelay, gunDelay) + 1);
  }

  private readonly settingsChanged = (event: CustomEvent<CrosshairSettings>): void => {
    this.settings = event.detail;
    this.render();
  };

  private readonly render = (): void => {
    const definition = CROSSHAIRS[this.settings.selected] ?? CROSSHAIRS[0];
    const hit = this.settings.effects && performance.now() < this.hitUntil;
    const teammate = this.settings.effects && this.settings.teammates && this.teammateAim && !hit;
    const image = hit ? definition.hit : teammate ? "/api/data/teammate.png" : definition.normal;
    const size = this.settings.size * this.element.parentElement!.clientWidth / 900;
    this.element.style.width = `${size}px`;
    this.element.style.height = `${size}px`;
    let red = 1, green = 1, blue = 1;
    if (teammate) { red = green = 0; blue = 1; }
    else if (this.settings.effects && this.settings.colors) {
      if (this.controller.owner.health <= 25) green = blue = 0;
      else if (this.controller.owner.health <= 50) { green = 0.5; blue = 0; }
    }
    if (this.settings.effects) {
      if (this.controller.gunWait > 0 && performance.now() - this.controller.lastAction < this.controller.gunWait) {
        red *= 0.5; green *= 0.5; blue *= 0.5;
      }
    }
    const color = `${red},${green},${blue}`;
    if (image !== this.image || color !== this.color) {
      this.image = image;
      this.color = color;
      this.draw(image, red, green, blue);
    }
  };

  private draw(source: string, red: number, green: number, blue: number): void {
    const generation = ++this.drawGeneration;
    const image = new Image();
    image.addEventListener("load", () => {
      if (generation !== this.drawGeneration) return;
      this.element.width = image.naturalWidth;
      this.element.height = image.naturalHeight;
      const context = this.element.getContext("2d", { alpha: true });
      if (!context) return;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, this.element.width, this.element.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        pixels.data[index] *= red;
        pixels.data[index + 1] *= green;
        pixels.data[index + 2] *= blue;
      }
      context.putImageData(pixels, 0, 0);
    });
    image.src = source;
  }
}
