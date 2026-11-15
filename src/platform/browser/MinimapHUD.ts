import type { Vec3 } from "../../engine/octa";
import { ClientState } from "../../engine/physics/types";
import type { CaptureBase, MultiplayerClient, NetworkPlayer } from "../../fpsgame/client";
import { collectTeamBase } from "../../fpsgame/collect";
import { ctfTeamFlag } from "../../fpsgame/ctf";
import { GameModeFlag, gameModeHas } from "../../fpsgame/game";

const MIN_RADAR_SCALE = 384;
const MAX_RADAR_SCALE = 1024;
const RADAR_MARGIN = 0.04;
const BLIP_MARGIN = 0.05;
const MOBILE_BLIP_ALPHA = 0.55;
const TEAMMATE_STATES = [ClientState.Alive, ClientState.Dead] as const;

type BlipName = "blue" | "red" | "grey" | "neutral" | "blue_flag" | "red_flag" | "neutral_flag" |
  "blue_skull" | "red_skull" | "blue_alive" | "red_alive" | "blue_dead" | "red_dead";

export interface MinimapView {
  position: Vec3;
  yaw: number;
  clientNumber: number;
  team: string;
}

export interface MinimapLayout { x: number; y: number; size: number; overlay: boolean }

// Original: src/fpsgame/client.cpp drawminimap()/drawteammates(), capture.h, ctf.h and collect.h drawhud().
// Phase 1 intentionally leaves the circular map texture as a neutral transparent field.
export class MinimapHUD {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly radar = this.loadImage("radar");
  private readonly blips = new Map<BlipName, HTMLImageElement>();
  private visible = true;
  private minimapRadius = 0;
  private readonly direction = { x: 0, y: 0 };

  constructor(parent: HTMLElement, private readonly multiplayer: MultiplayerClient) {
    this.element = document.createElement("canvas");
    this.element.className = "minimap-hud authentic-hud";
    this.element.setAttribute("aria-label", "Minimap");
    const context = this.element.getContext("2d", { alpha: true });
    if (!context) throw new Error("The minimap HUD requires a 2D canvas context.");
    this.context = context;
    for (const name of ["blue", "red", "grey", "neutral", "blue_flag", "red_flag", "neutral_flag", "blue_skull", "red_skull",
      "blue_alive", "red_alive", "blue_dead", "red_dead"] as const) this.blips.set(name, this.loadImage(`blip_${name}`));
    parent.append(this.element);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.hidden = !visible;
    if (!visible) this.clear();
  }

  setMinimapRadius(radius: number): void { this.minimapRadius = Math.max(0, radius); }

  render(view?: MinimapView, now = performance.now()): void {
    const mode = this.multiplayer.gameMode;
    if (!this.visible || !view || !needMinimap(mode)) { this.clear(); return; }
    const parent = this.element.parentElement;
    if (!parent) return;
    const width = parent.clientWidth, height = parent.clientHeight;
    this.resize(width, height);
    const context = this.context;
    context.clearRect(0, 0, width, height);

    const layout = minimapLayout(width, height, document.documentElement.classList.contains("mobile-gameplay"));
    const s = layout.size, x = layout.x, y = layout.y;
    if (layout.overlay) {
      context.save();
      context.beginPath();
      context.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
      context.fillStyle = "rgba(72, 76, 72, 0.28)";
      context.fill();
      context.restore();

      const roffset = s * RADAR_MARGIN, rsize = s + 2 * roffset;
      this.drawImage(this.radar, x - roffset, y - roffset, rsize, rsize);
    }
    if (!layout.overlay) { context.save(); context.globalAlpha = MOBILE_BLIP_ALPHA; }
    if (gameModeHas(mode, GameModeFlag.Ctf)) this.drawCtf(view, x, y, s, now);
    else if (gameModeHas(mode, GameModeFlag.Capture)) this.drawCapture(view, x, y, s, now);
    else if (gameModeHas(mode, GameModeFlag.Collect)) this.drawCollect(view, x, y, s);
    this.drawTeammates(view, x, y, s);
    if (!layout.overlay) context.restore();
  }

  dispose(): void { this.element.remove(); }

  private drawCtf(view: MinimapView, x: number, y: number, s: number, now: number): void {
    const hold = gameModeHas(this.multiplayer.gameMode, GameModeFlag.Hold);
    if (hold) for (const spawn of this.multiplayer.ctfMode.holdSpawnLocations) this.drawBlip("neutral", view, spawn, x, y, s, 0.05);
    for (const flag of this.multiplayer.ctfMode.flags) {
      if (hold ? flag.spawnIndex < 0 : flag.team < 1 || flag.team > 2) continue;
      const owner = flag.owner >= 0 ? this.multiplayer.players.get(flag.owner) : undefined;
      const team = hold ? owner ? ctfTeamFlag(owner.team) : 0 : flag.team;
      const color = !team ? "neutral" : team === ctfTeamFlag(this.localTeam()) ? "blue" : "red";
      if (!hold) this.drawBlip(color, view, flag.spawnLoc, x, y, s, 0.05);
      if (owner) {
        if (!hold && now % 1000 >= 500) continue;
      } else if (flag.dropped && (flag.dropLoc.x < 0 || now % 300 >= 150)) continue;
      const position = owner?.position ?? (flag.dropped ? flag.dropLoc : flag.spawnLoc);
      const marker = hold && (!owner || now % 1000 < 500) ? "neutral_flag" : `${color}_flag` as BlipName;
      this.drawBlip(marker, view, position, x, y, s, 0.1, true);
    }
  }

  private drawCapture(view: MinimapView, x: number, y: number, s: number, now: number): void {
    const showEnemies = now % 1000 >= 500, localTeam = this.localTeam();
    for (const base of this.multiplayer.captureModeBases) {
      if (base.ammoType <= 0 || base.ammoType > 6) continue;
      let marker: BlipName | undefined;
      if (showEnemies && base.enemy) marker = base.enemy === localTeam ? undefined : "red";
      else if (!base.owner) marker = "grey";
      else marker = base.owner === localTeam ? "blue" : "red";
      if (marker) this.drawCaptureBlip(marker, view, base, x, y, s);
    }
  }

  private drawCollect(view: MinimapView, x: number, y: number, s: number): void {
    const localTeam = collectTeamBase(this.localTeam());
    for (const base of this.multiplayer.collectMode.bases) {
      this.drawBlip(base.team === localTeam ? "blue" : "red", view, base.o, x, y, s, 0.05);
    }
    const viewedTeam = collectTeamBase(view.team), marker = viewedTeam === localTeam ? "red_skull" : "blue_skull";
    for (const player of this.multiplayer.players.values()) {
      if (player.clientNumber === view.clientNumber || player.state !== ClientState.Alive || player.tokens <= 0 ||
          collectTeamBase(player.team) === viewedTeam) continue;
      this.drawBlip(marker, view, player.position, x, y, s, 0.07);
    }
  }

  private drawCaptureBlip(marker: BlipName, view: MinimapView, base: CaptureBase, x: number, y: number, s: number): void {
    const size = 0.05, direction = radarDirection(view.position, base.o, view.yaw, this.calcradarscale(), 1 - BLIP_MARGIN - size,
      this.direction);
    this.drawImage(this.blips.get(marker), x + s * 0.5 * (1 + direction.x - size),
      y + s * 0.5 * (1 + direction.y - size), size * s, size * s);
  }

  private drawBlip(marker: BlipName, view: MinimapView, position: Vec3, x: number, y: number, s: number, size: number,
                   flagBlip = false): void {
    const direction = radarDirection(view.position, position, view.yaw, this.calcradarscale(), 1 - 2 * BLIP_MARGIN, this.direction);
    const xoffset = flagBlip ? -2 * (3 / 32) * size : -size;
    const yoffset = flagBlip ? -2 * (1 - 3 / 32) * size : -size;
    this.drawImage(this.blips.get(marker), x + s * 0.5 * (1 + direction.x + xoffset),
      y + s * 0.5 * (1 + direction.y + yoffset), size * s, size * s);
  }

  private drawTeammates(view: MinimapView, x: number, y: number, s: number): void {
    const localFriendly = view.team === this.localTeam(), scale = this.calcradarscale();
    for (const state of TEAMMATE_STATES) {
      const marker = (localFriendly ? state === ClientState.Alive ? "blue_alive" : "blue_dead"
        : state === ClientState.Alive ? "red_alive" : "red_dead") as BlipName;
      for (const player of this.multiplayer.players.values()) {
        if (player.clientNumber === view.clientNumber || player.state !== state || !view.team || player.team !== view.team) continue;
        this.drawTeammate(marker, view, player, x, y, s, scale);
      }
    }
  }

  private drawTeammate(marker: BlipName, view: MinimapView, player: NetworkPlayer, x: number, y: number, s: number, scale: number): void {
    const direction = radarDirection(view.position, player.position, view.yaw, scale, 1 - 2 * BLIP_MARGIN, this.direction), size = 0.06 * s;
    const bx = x + s * 0.5 * (1 + direction.x), by = y + s * 0.5 * (1 + direction.y), image = this.blips.get(marker);
    if (!image?.complete || !image.naturalWidth) return;
    const radians = (90 + player.yaw - view.yaw) * Math.PI / 180, sine = Math.sin(radians), cosine = Math.cos(radians);
    this.context.save();
    // Native drawteammate() emits its quad clockwise, swapping the texture axes as it rotates the four vertices.
    this.context.transform(-sine, cosine, cosine, sine, bx, by);
    this.context.drawImage(image, -size / 2, -size / 2, size, size);
    this.context.restore();
  }

  private calcradarscale(): number { return Math.min(MAX_RADAR_SCALE, Math.max(MIN_RADAR_SCALE, this.minimapRadius / 3)); }

  private localTeam(): string { return this.multiplayer.players.get(this.multiplayer.clientNumber)?.team ?? ""; }

  private drawImage(image: HTMLImageElement | undefined, x: number, y: number, width: number, height: number): void {
    if (image?.complete && image.naturalWidth) this.context.drawImage(image, x, y, width, height);
  }

  private resize(width: number, height: number): void {
    const ratio = window.devicePixelRatio || 1, pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (this.element.width === pixelWidth && this.element.height === pixelHeight) return;
    this.element.width = pixelWidth;
    this.element.height = pixelHeight;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private clear(): void {
    this.context.clearRect(0, 0, this.element.width, this.element.height);
  }

  private loadImage(name: string): HTMLImageElement {
    const image = new Image();
    image.src = `/api/packages/hud/${name}.png`;
    return image;
  }
}

export function needMinimap(mode: number): boolean {
  return gameModeHas(mode, GameModeFlag.Ctf) || gameModeHas(mode, GameModeFlag.Capture) || gameModeHas(mode, GameModeFlag.Collect);
}

export function minimapLayout(width: number, height: number, mobile: boolean): MinimapLayout {
  if (mobile) {
    const size = Math.min(height * 0.6, width * 0.45);
    return { x: (width - size) / 2, y: (height - size) / 2, size, overlay: false };
  }
  const size = height / 4;
  return { x: width - size - height / 40, y: height / 40, size, overlay: true };
}

export function radarDirection(origin: Vec3, target: Vec3, yaw: number, scale: number, maxDistance: number,
                               output: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  let x = (origin.x - target.x) / scale, y = (origin.y - target.y) / scale;
  const distance = Math.hypot(x, y);
  if (distance >= maxDistance) { x *= maxDistance / distance; y *= maxDistance / distance; }
  const radians = yaw * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  output.x = x * cosine + y * sine;
  output.y = -x * sine + y * cosine;
  return output;
}

export function minimapRadiusFromGeometry(batches: readonly { positions: readonly number[] }[], fallback: number): number {
  let minimumX = Number.POSITIVE_INFINITY, minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY, maximumY = Number.NEGATIVE_INFINITY;
  for (const batch of batches) {
    for (let index = 0; index < batch.positions.length; index += 3) {
      minimumX = Math.min(minimumX, batch.positions[index]);
      maximumX = Math.max(maximumX, batch.positions[index]);
      minimumY = Math.min(minimumY, batch.positions[index + 2]);
      maximumY = Math.max(maximumY, batch.positions[index + 2]);
    }
  }
  return Number.isFinite(minimumX) ? Math.max(maximumX - minimumX, maximumY - minimumY) / 2 : fallback / 2;
}
