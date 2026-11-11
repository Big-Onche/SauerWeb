import type { NetworkPlayer } from "../../fpsgame/client";

export class SpectatorHUD {
  private readonly element: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "spectator-hud";
    this.element.hidden = true;
    parent.append(this.element);
  }

  render(spectating: boolean, followed?: NetworkPlayer): void {
    this.element.hidden = !spectating;
    this.element.innerHTML = spectating ? `<strong>SPECTATOR</strong>${followed ? `<span>${escapeHtml(followed.name)}</span>` : ""}` : "";
  }

  dispose(): void {
    this.element.remove();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
