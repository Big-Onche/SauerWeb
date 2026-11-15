import type { LoadingProgressUpdate } from "../../assets/LoadingProgress";

// Original: src/engine/main.cpp
// Functions: renderbackground(const char *caption, Texture *mapshot, const char *mapname, const char *mapinfo, bool restore, bool force),
// renderprogress(float bar, const char *text, GLuint tex, bool background)
// Sauerbraten reference: SVN r6488
export class LoadingScreen {
  private readonly fill: HTMLElement;
  private readonly track: HTMLElement;
  private readonly text: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly percent: HTMLElement;
  private visible = true;

  constructor(private readonly element: HTMLElement) {
    this.fill = required(element, ".loading-bar-fill");
    this.track = required(element, ".loading-bar-track");
    this.text = required(element, ".loading-text");
    this.detail = required(element, ".loading-detail");
    this.percent = required(element, ".loading-percent");
  }

  show(mapName: string): void {
    this.visible = true;
    this.element.hidden = false;
    this.element.setAttribute("aria-busy", "true");
    const map = this.element.querySelector<HTMLElement>(".loading-map");
    if (map) map.textContent = mapName;
    this.update({ fraction: 0, text: "loading..." });
  }

  update(update: LoadingProgressUpdate): void {
    if (!this.visible) return;
    const fraction = Math.min(1, Math.max(0, update.fraction));
    this.fill.style.setProperty("--loading-cap-width", `${this.track.clientWidth * 7 / 477}px`);
    this.fill.style.width = `${fraction * 100}%`;
    this.text.textContent = update.text;
    this.detail.textContent = update.detail ?? "";
    this.percent.textContent = `${Math.floor(fraction * 100)}%`;
    this.element.setAttribute("aria-valuenow", String(Math.floor(fraction * 100)));
  }

  hide(): void {
    this.visible = false;
    this.element.hidden = true;
    this.element.setAttribute("aria-busy", "false");
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing loading-screen element: ${selector}`);
  return element;
}
