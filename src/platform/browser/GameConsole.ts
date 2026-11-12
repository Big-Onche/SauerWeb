export type ConsoleLineType = "info" | "error" | "chat" | "team-chat" | "game-info" | "frag-self" | "frag-other" | "teamkill";

export interface ConsoleLine {
  id: number;
  type: ConsoleLineType;
  text: string;
  outTime: number;
}

const MAX_CONSOLE_LINES = 200;
const HUD_LINE_COUNT = 5;
const HUD_FADE_MILLISECONDS = 30_000;

// Original: src/engine/console.cpp, conline(), renderconsole(), toggleconsole.
export class GameConsole {
  private readonly element: HTMLElement;
  private readonly linesElement: HTMLElement;
  private readonly miniElement: HTMLElement;
  private readonly lines: ConsoleLine[] = [];
  private nextId = 0;
  private fullConsole = false;
  private skip = 0;
  private fadeTimer = 0;

  constructor(parent: HTMLElement) {
    this.element = document.createElement("section");
    this.element.className = "game-console";
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-label", "Game console");
    this.linesElement = document.createElement("div");
    this.linesElement.className = "game-console-lines";
    this.element.append(this.linesElement);
    this.miniElement = document.createElement("section");
    this.miniElement.className = "game-chat-console";
    this.miniElement.setAttribute("aria-live", "polite");
    this.miniElement.setAttribute("aria-label", "Chat console");
    parent.append(this.element, this.miniElement);
  }

  add(text: string, type: ConsoleLineType = "info"): void {
    const clean = stripSauerFormatting(text).slice(0, 511);
    if (!clean) return;
    this.lines.push({ id: this.nextId++, type, text: clean, outTime: performance.now() });
    if (this.lines.length > MAX_CONSOLE_LINES) this.lines.splice(0, this.lines.length - MAX_CONSOLE_LINES);
    this.skip = 0;
    this.render();
    window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => this.render(), HUD_FADE_MILLISECONDS + 50);
  }

  toggle(): boolean {
    this.fullConsole = !this.fullConsole;
    this.element.classList.toggle("full", this.fullConsole);
    this.miniElement.hidden = this.fullConsole;
    this.render();
    return this.fullConsole;
  }

  scroll(amount: number): void {
    if (!this.fullConsole || !this.lines.length) return;
    this.skip = Math.min(this.lines.length - 1, Math.max(0, this.skip + amount));
    this.render();
  }

  get isFull(): boolean { return this.fullConsole; }

  dispose(): void {
    window.clearTimeout(this.fadeTimer);
    this.element.remove();
    this.miniElement.remove();
  }

  private render(): void {
    const now = performance.now();
    const end = Math.max(0, this.lines.length - this.skip);
    const visible = this.fullConsole
      ? this.lines.slice(0, end)
      : this.lines.slice(-HUD_LINE_COUNT).filter((line) => now - line.outTime < HUD_FADE_MILLISECONDS);
    this.linesElement.replaceChildren(...visible.map((line) => {
      const element = document.createElement("p");
      element.className = `console-line ${line.type}`;
      element.textContent = line.text;
      return element;
    }));
    if (this.fullConsole) this.linesElement.scrollTop = this.linesElement.scrollHeight;
    // Native miniconfilter defaults to zero; chat and frag lines are part of the normal five-line console above.
    this.miniElement.replaceChildren();
  }
}

// Cube color escapes are display instructions, not chat content. The web console colors by message type.
export function stripSauerFormatting(text: string): string {
  return text.replace(/\f(?:\[[^\]]*\]|.)/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
