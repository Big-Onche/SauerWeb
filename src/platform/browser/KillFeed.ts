import type { MultiplayerClient, MultiplayerEvent } from "../../fpsgame/client";
import { PLAYER_GUN_COUNT } from "../../fpsgame/weapon/WeaponDefinitions";
import { loadTouchSettings, TOUCH_SETTINGS_CHANGED, touchControlsWanted, type TouchSettings } from "./TouchSettings";

interface FeedEntry { id: number; event: Extract<MultiplayerEvent, { type: "frag" }>; timeout: number }

export class KillFeed {
  private readonly root: HTMLElement;
  private readonly entries: FeedEntry[] = [];
  private nextId = 0;
  private settings = loadTouchSettings();

  constructor(parent: HTMLElement, private readonly client: MultiplayerClient) {
    this.root = document.createElement("section");
    this.root.className = "mobile-kill-feed";
    this.root.setAttribute("aria-label", "Kill feed");
    parent.append(this.root);
    client.addEventListener("multiplayer", this.onMultiplayer);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.render();
  }

  dispose(): void {
    this.client.removeEventListener("multiplayer", this.onMultiplayer);
    window.removeEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.entries.forEach((entry) => window.clearTimeout(entry.timeout));
    this.root.remove();
  }

  private readonly onMultiplayer = (event: Event): void => {
    const detail = (event as CustomEvent<MultiplayerEvent>).detail;
    if (detail.type !== "frag") return;
    const id = this.nextId++;
    const timeout = window.setTimeout(() => {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index >= 0) this.entries.splice(index, 1);
      this.render();
    }, 5_000);
    this.entries.push({ id, event: detail, timeout });
    while (this.entries.length > 3) window.clearTimeout(this.entries.shift()!.timeout);
    this.render();
  };

  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => { this.settings = event.detail; this.render(); };

  private render(): void {
    this.root.hidden = !touchControlsWanted(this.settings);
    this.root.replaceChildren(...this.entries.map(({ event }) => {
      const line = document.createElement("div");
      line.className = `kill-feed-line${event.teamkill ? " teamkill" : ""}${event.suicide ? " suicide" : ""}`;
      line.append(this.name(event.killer, event.killerTeam));
      if (!event.suicide && event.gun !== undefined && event.gun >= 0 && event.gun < PLAYER_GUN_COUNT) {
        const icon = document.createElement("i");
        const index = 4 + event.gun;
        icon.className = "kill-feed-weapon";
        icon.style.backgroundPosition = `${index % 4 * 100 / 3}% ${Math.trunc(index / 4) * 100 / 3}%`;
        line.append(icon);
      } else {
        const marker = document.createElement("i");
        marker.className = "kill-feed-special";
        marker.textContent = event.suicide ? "×" : "→";
        line.append(marker);
      }
      if (!event.suicide) line.append(this.name(event.victim, event.victimTeam));
      else line.append("self");
      return line;
    }));
  }

  private name(value: string, team?: string): HTMLElement {
    const element = document.createElement("span");
    element.className = team === "good" ? "team-good" : team === "evil" ? "team-evil" : "";
    element.textContent = value;
    element.title = value;
    return element;
  }
}
