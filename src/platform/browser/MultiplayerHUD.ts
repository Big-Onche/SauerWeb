import type { MultiplayerClient, MultiplayerEvent } from "../../fpsgame/client";
import { gameModeName } from "../../fpsgame/game";

export class MultiplayerHUD {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;
  private visible = false;

  constructor(viewport: HTMLElement, private readonly client: MultiplayerClient) {
    this.root = document.createElement("div");
    this.root.className = "multiplayer-hud";
    this.root.hidden = true;
    this.root.innerHTML = `<div class="multiplayer-status"></div><div class="multiplayer-scoreboard" hidden></div>`;
    viewport.append(this.root);
    this.status = this.required(".multiplayer-status");
    this.scoreboard = this.required(".multiplayer-scoreboard");
    client.addEventListener("multiplayer", (event) => this.handle((event as CustomEvent<MultiplayerEvent>).detail));
    window.addEventListener("keydown", (event) => {
      if (event.code === "Tab" && this.visible) { event.preventDefault(); this.scoreboard.hidden = false; this.render(); }
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Tab") this.scoreboard.hidden = true; });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
    if (visible) this.render();
  }

  render(): void {
    if (!this.visible) return;
    const player = this.client.players.get(this.client.clientNumber);
    this.status.innerHTML = `<span>${escapeHtml(this.client.serverDescription || "Sauerbraten")}</span>` +
      `<strong>${escapeHtml(gameModeName(this.client.gameMode))}</strong><span>${escapeHtml(this.client.mapName)}</span>` +
      `<b>${player?.health ?? 0} HP</b><span>${formatTime(this.client.timeLeftSeconds)}</span>`;
    this.scoreboard.innerHTML = `<header><span>${escapeHtml(this.client.serverDescription || "scoreboard")}</span>` +
      `<small>${escapeHtml(gameModeName(this.client.gameMode))} · ${escapeHtml(this.client.mapName)}</small></header>` +
      `<div class="score-heading"><span>player</span><span>frags</span><span>deaths</span><span>ping</span></div>` +
      this.client.scoreboard.map((entry) => `<div class="score-row${entry.clientNumber === this.client.clientNumber ? " local" : ""}">` +
        `<span>${escapeHtml(entry.name)}${entry.team ? ` <i>${escapeHtml(entry.team)}</i>` : ""}</span><b>${entry.frags}</b>` +
        `<span>${entry.deaths}</span><span>${entry.ping}</span></div>`).join("");
  }

  private handle(event: MultiplayerEvent): void {
    if (event.type === "status") this.status.textContent = event.status;
    else if (event.type === "message") this.status.textContent = event.text;
    else if (event.type === "disconnect") this.status.textContent = `disconnected (${event.reason})`;
    this.render();
  }

  private required(selector: string): HTMLDivElement {
    const element = this.root.querySelector<HTMLDivElement>(selector);
    if (!element) throw new Error(`Missing multiplayer HUD element ${selector}.`);
    return element;
  }
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.trunc(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
