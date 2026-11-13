import { ClientState } from "../../engine/physics/types";
import type { MultiplayerClient, MultiplayerEvent, NetworkPlayer } from "../../fpsgame/client";
import { GameModeFlag, gameModeHas, gameModeName } from "../../fpsgame/game";
import { guiSkinMarkup } from "../../guiSkin";

const MODEL_ICONS = ["mrfixit", "snoutx10k", "ogro", "inky", "captaincannon"];

export class MultiplayerHUD {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;
  private visible = false;
  private connectionStatus = "not connected";
  private scoreboardModal = false;

  constructor(viewport: HTMLElement, private readonly client: MultiplayerClient) {
    this.root = document.createElement("div");
    this.root.className = "multiplayer-hud";
    this.root.hidden = true;
    this.root.innerHTML = `<div class="multiplayer-status"></div><div class="multiplayer-scoreboard" hidden></div>`;
    viewport.append(this.root);
    this.status = this.required(".multiplayer-status");
    this.scoreboard = this.required(".multiplayer-scoreboard");
    client.addEventListener("multiplayer", this.onMultiplayer);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.root.addEventListener("click", this.onClick);
  }

  dispose(): void {
    this.client.removeEventListener("multiplayer", this.onMultiplayer);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.root.removeEventListener("click", this.onClick);
    this.root.remove();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) { this.scoreboardModal = false; this.root.classList.remove("scoreboard-modal"); this.scoreboard.hidden = true; }
    this.root.hidden = !visible;
    if (visible) this.render();
  }

  showTouchScoreboard(): void {
    if (!this.visible) return;
    this.scoreboardModal = true;
    this.root.classList.add("scoreboard-modal");
    this.scoreboard.hidden = false;
    this.render();
  }

  render(): void {
    if (!this.visible) return;
    const player = this.client.players.get(this.client.clientNumber);
    this.status.hidden = this.client.connected || this.client.isLocalGame;
    if (!this.status.hidden) this.status.textContent = this.connectionStatus;
    this.scoreboard.innerHTML = this.renderScoreboard(player?.team ?? "");
  }

  private renderScoreboard(localTeam: string): string {
    const players = this.client.scoreboard;
    const spectators = players.filter((player) => player.state === ClientState.Spectator);
    const playing = players.filter((player) => player.state !== ClientState.Spectator);
    const teamMode = gameModeHas(this.client.gameMode, GameModeFlag.Team);
    const groups = new Map<string, NetworkPlayer[]>();
    for (const player of playing) {
      const team = teamMode ? player.team : "";
      const group = groups.get(team) ?? [];
      group.push(player);
      groups.set(team, group);
    }
    const sortedGroups = [...groups].sort(([leftTeam, left], [rightTeam, right]) =>
      this.client.getTeamScore(rightTeam) - this.client.getTeamScore(leftTeam) || right.length - left.length || leftTeam.localeCompare(rightTeam));
    const groupMarkup = sortedGroups.map(([team, entries]) => this.renderGroup(team, entries, localTeam)).join("");
    const title = escapeHtml(this.client.serverDescription || "scoreboard");
    const details = `${escapeHtml(gameModeName(this.client.gameMode))}  ${escapeHtml(this.client.mapName)}  ` +
      formatTime(this.client.timeLeftSeconds);
    const close = this.scoreboardModal ? `<button class="scoreboard-close" type="button" aria-label="Close scoreboard">×</button>` : "";
    return `${close}${guiSkinMarkup()}<header><span>${title}</span>` +
      `<small>${details}</small></header><div class="score-groups ${teamMode ? "team-groups" : ""}">${groupMarkup}</div>` +
      (spectators.length ? `<div class="score-spectators"><strong>spectators</strong>${spectators.map((entry) =>
        `<span>${escapeHtml(entry.name)} <small>${entry.ping} ping · cn ${entry.clientNumber}</small></span>`).join("")}</div>` : "");
  }

  private renderGroup(team: string, players: NetworkPlayer[], localTeam: string): string {
    const friendly = Boolean(team && team === localTeam);
    const ctf = gameModeHas(this.client.gameMode, GameModeFlag.Ctf);
    const heading = team ? `${escapeHtml(team)}: ${this.client.getTeamScore(team)}` : "players";
    return `<section class="score-team ${team ? friendly ? "friendly" : "enemy" : "free-for-all"}${ctf ? " ctf" : ""}">` +
      `<h2>${heading}</h2><div class="score-heading"><span></span>${ctf ? "<span>flags</span>" : ""}<span>frags</span><span>deaths</span>` +
      `<span>name</span><span>ping</span><span>cn</span></div>` +
      players.map((entry) => this.renderPlayer(entry, friendly, ctf)).join("") + `</section>`;
  }

  private renderPlayer(entry: NetworkPlayer, friendly: boolean, ctf: boolean): string {
    const icon = MODEL_ICONS[entry.model] ?? MODEL_ICONS[0];
    const iconName = `${icon}${entry.team ? friendly ? "_blue" : "_red" : ""}`;
    const classes = `score-row${entry.clientNumber === this.client.clientNumber ? " local" : ""}` +
      `${entry.state === ClientState.Dead ? " dead" : ""}`;
    return `<div class="${classes}">` +
      `<img src="/api/packages/icons/${iconName}.jpg" alt="" />${ctf ? `<b>${entry.flags}</b>` : ""}<span>${entry.frags}</span>` +
      `<span>${entry.deaths}</span><strong>${escapeHtml(entry.name)}</strong><span>${entry.ping}</span><span>${entry.clientNumber}</span></div>`;
  }

  private handle(event: MultiplayerEvent): void {
    if (event.type === "status") this.connectionStatus = event.status;
    else if (event.type === "disconnect") this.connectionStatus = `disconnected (${event.reason})`;
    this.render();
  }

  private readonly onMultiplayer = (event: Event): void => {
    this.handle((event as CustomEvent<MultiplayerEvent>).detail);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Tab" && this.visible) { event.preventDefault(); this.scoreboard.hidden = false; this.render(); }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Tab" && !this.scoreboardModal) this.scoreboard.hidden = true;
  };

  private readonly onClick = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest(".scoreboard-close")) return;
    this.scoreboardModal = false;
    this.root.classList.remove("scoreboard-modal");
    this.scoreboard.hidden = true;
  };

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
