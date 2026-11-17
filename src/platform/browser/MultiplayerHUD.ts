import { ClientState } from "../../engine/physics/types";
import type { MultiplayerClient, MultiplayerEvent, NetworkPlayer } from "../../fpsgame/client";
import { GameModeFlag, gameModeHas, gameModeName } from "../../fpsgame/game";
import { guiSkinMarkup } from "../../guiSkin";

const MODEL_ICONS = ["mrfixit", "snoutx10k", "ogro", "inky", "captaincannon"];

interface ScoreboardPlayer {
  clientNumber: number;
  deaths: number;
  flags: number;
  frags: number;
  model: number;
  name: string;
  ping: number;
  state: ClientState;
  team: string;
}

interface ScoreboardGroup {
  players: ScoreboardPlayer[];
  score: number;
  team: string;
}

interface ScoreboardState {
  collect: boolean;
  details: string;
  groups: ScoreboardGroup[];
  localClientNumber: number;
  localTeam: string;
  objective: boolean;
  spectators: ScoreboardPlayer[];
  teamMode: boolean;
  title: string;
}

interface PlayerRowElements {
  clientNumber: HTMLSpanElement;
  deaths: HTMLSpanElement;
  flags?: HTMLElement;
  frags: HTMLSpanElement;
  icon: HTMLImageElement;
  name: HTMLElement;
  ping: HTMLSpanElement;
  root: HTMLDivElement;
}

interface GroupElements {
  heading: HTMLHeadingElement;
  rows: Map<number, PlayerRowElements>;
  root: HTMLElement;
}

interface SpectatorElements {
  details: HTMLElement;
  name: Text;
  root: HTMLSpanElement;
}

export class MultiplayerHUD {
  private readonly root: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly scoreboard: HTMLDivElement;
  private readonly closeScoreboard: HTMLButtonElement;
  private readonly scoreboardTitle: HTMLSpanElement;
  private readonly scoreboardDetails: HTMLElement;
  private readonly scoreGroups: HTMLDivElement;
  private readonly spectatorList: HTMLDivElement;
  private readonly groupElements = new Map<string, GroupElements>();
  private readonly spectatorElements = new Map<number, SpectatorElements>();
  private visible = false;
  private connectionStatus = "not connected";
  private scoreboardModal = false;
  private scoreboardDirty = true;
  private renderedState?: ScoreboardState;

  constructor(viewport: HTMLElement, private readonly client: MultiplayerClient) {
    this.root = document.createElement("div");
    this.root.className = "multiplayer-hud";
    this.root.hidden = true;
    this.root.innerHTML = `<div class="multiplayer-status"></div><div class="multiplayer-scoreboard" hidden>` +
      `<button class="scoreboard-close" type="button" aria-label="Close scoreboard" hidden>×</button>${guiSkinMarkup()}` +
      `<header><span></span><small></small></header><div class="score-groups"></div>` +
      `<div class="score-spectators" hidden><strong>spectators</strong></div></div>`;
    viewport.append(this.root);
    this.status = this.required(".multiplayer-status");
    this.scoreboard = this.required(".multiplayer-scoreboard");
    this.closeScoreboard = this.required(".scoreboard-close");
    this.scoreboardTitle = this.required("header span");
    this.scoreboardDetails = this.required("header small");
    this.scoreGroups = this.required(".score-groups");
    this.spectatorList = this.required(".score-spectators");
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
    this.clearScoreboardReferences();
    this.root.remove();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.scoreboardModal = false;
      this.root.classList.remove("scoreboard-modal");
      this.scoreboard.hidden = true;
      this.closeScoreboard.hidden = true;
    }
    this.root.hidden = !visible;
    if (visible) this.updateStatus();
  }

  showTouchScoreboard(): void {
    if (!this.visible) return;
    this.scoreboardModal = true;
    this.root.classList.add("scoreboard-modal");
    this.closeScoreboard.hidden = false;
    this.showScoreboard();
  }

  render(): void {
    if (!this.visible || this.scoreboard.hidden || !this.scoreboardDirty) return;
    this.scoreboardDirty = false;
    this.updateScoreboard(collectScoreboardState(this.client));
  }

  private showScoreboard(): void {
    if (this.scoreboard.hidden) this.scoreboard.hidden = false;
    this.render();
  }

  private updateScoreboard(state: ScoreboardState): void {
    setText(this.scoreboardTitle, state.title);
    setText(this.scoreboardDetails, state.details);
    setClass(this.scoreGroups, "team-groups", state.teamMode);
    if (!this.renderedState || scoreboardStructureChanged(this.renderedState, state)) this.rebuildScoreboard(state);
    else this.updateScoreboardValues(state);
    this.renderedState = state;
  }

  private rebuildScoreboard(state: ScoreboardState): void {
    this.groupElements.clear();
    this.spectatorElements.clear();
    const groupFragment = document.createDocumentFragment();
    for (const group of state.groups) {
      const elements = this.createGroup(group, state);
      this.groupElements.set(group.team, elements);
      groupFragment.append(elements.root);
    }
    this.scoreGroups.replaceChildren(groupFragment);
    const spectatorFragment = document.createDocumentFragment();
    spectatorFragment.append(this.createElement("strong", "spectators"));
    for (const spectator of state.spectators) {
      const elements = this.createSpectator(spectator);
      this.spectatorElements.set(spectator.clientNumber, elements);
      spectatorFragment.append(elements.root);
    }
    this.spectatorList.replaceChildren(spectatorFragment);
    this.spectatorList.hidden = state.spectators.length === 0;
  }

  private updateScoreboardValues(state: ScoreboardState): void {
    for (const group of state.groups) {
      const elements = this.groupElements.get(group.team);
      if (!elements) continue;
      this.updateGroupHeading(elements.heading, group);
      const friendly = Boolean(group.team && group.team === state.localTeam);
      setClass(elements.root, "friendly", Boolean(group.team && friendly));
      setClass(elements.root, "enemy", Boolean(group.team && !friendly));
      for (const player of group.players) {
        const row = elements.rows.get(player.clientNumber);
        if (row) this.updatePlayerRow(row, player, state, friendly);
      }
    }
    for (const spectator of state.spectators) {
      const elements = this.spectatorElements.get(spectator.clientNumber);
      if (!elements) continue;
      setText(elements.name, `${spectator.name} `);
      setText(elements.details, `${spectator.ping} ping · cn ${spectator.clientNumber}`);
    }
  }

  private createGroup(group: ScoreboardGroup, state: ScoreboardState): GroupElements {
    const friendly = Boolean(group.team && group.team === state.localTeam);
    const root = this.createElement("section", "", `score-team ${group.team ? friendly ? "friendly" : "enemy" : "free-for-all"}`);
    if (state.objective) root.classList.add("ctf");
    const heading = this.createElement("h2");
    this.updateGroupHeading(heading, group);
    root.append(heading, this.createScoreHeading(state));
    const rows = new Map<number, PlayerRowElements>();
    for (const player of group.players) {
      const row = this.createPlayerRow(player, state, friendly);
      rows.set(player.clientNumber, row);
      root.append(row.root);
    }
    return { heading, root, rows };
  }

  private createScoreHeading(state: ScoreboardState): HTMLDivElement {
    const heading = this.createElement("div", "", "score-heading");
    heading.append(this.createElement("span"));
    if (state.objective) heading.append(this.createElement("span", state.collect ? "skulls" : "flags"));
    for (const label of ["frags", "deaths", "name", "ping", "cn"]) heading.append(this.createElement("span", label));
    return heading;
  }

  private createPlayerRow(player: ScoreboardPlayer, state: ScoreboardState, friendly: boolean): PlayerRowElements {
    const root = this.createElement("div", "", "score-row");
    const icon = document.createElement("img");
    icon.alt = "";
    root.append(icon);
    const flags = state.objective ? this.createElement("b") : undefined;
    if (flags) root.append(flags);
    const frags = this.createElement("span"), deaths = this.createElement("span"), name = this.createElement("strong");
    const ping = this.createElement("span"), clientNumber = this.createElement("span");
    root.append(frags, deaths, name, ping, clientNumber);
    const elements = { clientNumber, deaths, flags, frags, icon, name, ping, root };
    this.updatePlayerRow(elements, player, state, friendly);
    return elements;
  }

  private updatePlayerRow(row: PlayerRowElements, player: ScoreboardPlayer, state: ScoreboardState, friendly: boolean): void {
    const icon = MODEL_ICONS[player.model] ?? MODEL_ICONS[0];
    const iconName = `${icon}${player.team ? friendly ? "_blue" : "_red" : ""}`;
    const iconSource = `/api/packages/icons/${iconName}.jpg`;
    if (row.icon.getAttribute("src") !== iconSource) row.icon.src = iconSource;
    setClass(row.root, "local", player.clientNumber === state.localClientNumber);
    setClass(row.root, "dead", player.state === ClientState.Dead);
    if (row.flags) setText(row.flags, String(player.flags));
    setText(row.frags, String(player.frags));
    setText(row.deaths, String(player.deaths));
    setText(row.name, player.name);
    setText(row.ping, String(player.ping));
    setText(row.clientNumber, String(player.clientNumber));
  }

  private updateGroupHeading(heading: HTMLHeadingElement, group: ScoreboardGroup): void {
    const score = gameModeHas(this.client.gameMode, GameModeFlag.Capture) && group.score >= 10_000 ? "WIN" : String(group.score);
    setText(heading, group.team ? `${group.team}: ${score}` : "players");
  }

  private createSpectator(player: ScoreboardPlayer): SpectatorElements {
    const root = this.createElement("span");
    const name = document.createTextNode(`${player.name} `);
    const details = this.createElement("small", `${player.ping} ping · cn ${player.clientNumber}`);
    root.append(name, details);
    return { details, name, root };
  }

  private handle(event: MultiplayerEvent): void {
    if (event.type === "status") {
      this.connectionStatus = event.status;
      this.scoreboardDirty = true;
      this.updateStatus();
    } else if (event.type === "disconnect") {
      this.connectionStatus = `disconnected (${event.reason})`;
      this.clearScoreboardReferences();
      this.updateStatus();
    } else if (event.type === "players" || event.type === "scoreboard" || event.type === "map-change" || event.type === "bot-init" ||
               event.type === "spawn") {
      this.scoreboardDirty = true;
    }
  }

  private updateStatus(): void {
    if (!this.visible) return;
    const hidden = this.client.connected || this.client.isLocalGame;
    if (this.status.hidden !== hidden) this.status.hidden = hidden;
    if (!hidden) setText(this.status, this.connectionStatus);
  }

  private clearScoreboardReferences(): void {
    this.groupElements.clear();
    this.spectatorElements.clear();
    this.renderedState = undefined;
    this.scoreboardDirty = true;
  }

  private readonly onMultiplayer = (event: Event): void => {
    this.handle((event as CustomEvent<MultiplayerEvent>).detail);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Tab" || !this.visible) return;
    event.preventDefault();
    this.showScoreboard();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Tab" && !this.scoreboardModal) this.scoreboard.hidden = true;
  };

  private readonly onClick = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest(".scoreboard-close")) return;
    this.scoreboardModal = false;
    this.root.classList.remove("scoreboard-modal");
    this.closeScoreboard.hidden = true;
    this.scoreboard.hidden = true;
  };

  private createElement<K extends keyof HTMLElementTagNameMap>(tagName: K, text = "", className = ""): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  private required<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing multiplayer HUD element ${selector}.`);
    return element;
  }
}

function collectScoreboardState(client: MultiplayerClient): ScoreboardState {
  const players = client.scoreboard.map(scoreboardPlayer);
  const spectators = players.filter((player) => player.state === ClientState.Spectator);
  const playing = players.filter((player) => player.state !== ClientState.Spectator);
  const teamMode = gameModeHas(client.gameMode, GameModeFlag.Team);
  const groups = new Map<string, ScoreboardPlayer[]>();
  for (const player of playing) {
    const team = teamMode ? player.team : "";
    const group = groups.get(team);
    if (group) group.push(player);
    else groups.set(team, [player]);
  }
  const sortedGroups = [...groups].map(([team, groupPlayers]) => ({ team, players: groupPlayers, score: client.getTeamScore(team) }));
  sortedGroups.sort((left, right) => right.score - left.score || right.players.length - left.players.length || left.team.localeCompare(right.team));
  const localTeam = client.players.get(client.clientNumber)?.team ?? "";
  const collect = gameModeHas(client.gameMode, GameModeFlag.Collect);
  return {
    collect,
    details: `${gameModeName(client.gameMode)}  ${client.mapName}  ${formatTime(client.timeLeftSeconds)}`,
    groups: sortedGroups,
    localClientNumber: client.clientNumber,
    localTeam,
    objective: gameModeHas(client.gameMode, GameModeFlag.Ctf) || collect,
    spectators,
    teamMode,
    title: client.serverDescription || "scoreboard",
  };
}

function scoreboardPlayer(player: NetworkPlayer): ScoreboardPlayer {
  return {
    clientNumber: player.clientNumber,
    deaths: player.deaths,
    flags: player.flags,
    frags: player.frags,
    model: player.model,
    name: player.name,
    ping: player.ping,
    state: player.state,
    team: player.team,
  };
}

function scoreboardStructureChanged(previous: ScoreboardState, next: ScoreboardState): boolean {
  if (previous.objective !== next.objective || previous.collect !== next.collect || previous.teamMode !== next.teamMode ||
      previous.groups.length !== next.groups.length || previous.spectators.length !== next.spectators.length) return true;
  for (let groupIndex = 0; groupIndex < next.groups.length; groupIndex++) {
    const previousGroup = previous.groups[groupIndex], nextGroup = next.groups[groupIndex];
    if (previousGroup.team !== nextGroup.team || previousGroup.players.length !== nextGroup.players.length) return true;
    for (let playerIndex = 0; playerIndex < nextGroup.players.length; playerIndex++) {
      if (previousGroup.players[playerIndex].clientNumber !== nextGroup.players[playerIndex].clientNumber) return true;
    }
  }
  for (let index = 0; index < next.spectators.length; index++) {
    if (previous.spectators[index].clientNumber !== next.spectators[index].clientNumber) return true;
  }
  return false;
}

function setClass(element: Element, className: string, enabled: boolean): void {
  if (element.classList.contains(className) !== enabled) element.classList.toggle(className, enabled);
}

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.trunc(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
