import { ClientState } from "../../engine/physics/types";
import type { MultiplayerClient } from "../../fpsgame/client";
import { GameModeFlag, gameModeHas } from "../../fpsgame/game";
import type { WeaponController } from "../../fpsgame/weapon/WeaponController";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";

// Original: src/fpsgame/game.h (HICON_*), fps.cpp (drawhudicons/gameplayhud), scoreboard.cpp (drawhudscore),
// and src/engine/rendergl.cpp (drawdamagescreen). The native HUD uses a 1800-unit-high coordinate system.
const HUD_HEIGHT = 1800;
const ICON_X = 20;
const ICON_Y = 1650;
const ICON_TEXT_Y = 1644;
const ICON_STEP = 490;
const ICON_SIZE = 120;
const ICON_SPACE = 40;
const FONT_HEIGHT = 64;

const Icon = {
  BlueArmour: 0,
  Health: 3,
  Fist: 4,
  Quad: 11,
  RedFlag: 12,
  BlueFlag: 13,
  NeutralFlag: 14,
  Token: 15,
} as const;

export interface HudPlayerView {
  health: number;
  maxHealth: number;
  armour: number;
  armourType: number;
  selectedGun: number;
  ammo: ArrayLike<number>;
  state: ClientState;
  flags: number;
  clientNumber?: number;
}

export class WeaponHUD {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly items = loadImage("/api/packages/hud/items.png", () => this.invalidate());
  private readonly damage = loadImage("/api/packages/hud/damage.png", () => this.invalidate());
  private visible = true;
  private view?: HudPlayerView;
  private lastFrame = "";
  private damageUntil = 0;
  private animationFrame = 0;

  constructor(parent: HTMLElement, private readonly controller: WeaponController, events: WeaponEvents,
              private readonly multiplayer?: MultiplayerClient) {
    this.element = document.createElement("canvas");
    this.element.className = "weapon-hud authentic-hud";
    this.element.setAttribute("aria-label", "Player status");
    const context = this.element.getContext("2d", { alpha: true });
    if (!context) throw new Error("The native HUD requires a 2D canvas context.");
    this.context = context;
    parent.append(this.element);
    events.on((event) => this.handle(event));
    window.addEventListener("resize", this.invalidate);
    document.fonts?.load(`${FONT_HEIGHT}px Sauerbraten`).then(this.invalidate).catch(() => undefined);
    this.render();
  }

  render(view?: HudPlayerView): void {
    this.view = view ?? this.view;
    if (!this.visible) return;
    const current = this.currentView();
    const width = this.element.parentElement?.clientWidth ?? 0;
    const height = this.element.parentElement?.clientHeight ?? 0;
    const clock = this.multiplayer ? Math.max(0, this.multiplayer.timeLeftSeconds) : 0;
    const damageActive = performance.now() < this.damageUntil;
    const frame = [width, height, current.health, current.maxHealth, current.armour, current.armourType, current.selectedGun,
      current.state, current.flags, this.controller.quadMilliseconds > 0, clock, damageActive,
      ...Array.from({ length: 7 }, (_, gun) => current.ammo[gun] ?? 0)].join(":");
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.draw(width, height, current, clock);
    if (damageActive) this.animationFrame = requestAnimationFrame(() => { this.lastFrame = ""; this.render(); });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.hidden = !visible;
    if (visible) this.invalidate();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener("resize", this.invalidate);
    this.element.remove();
  }

  private currentView(): HudPlayerView {
    if (this.view) return this.view;
    const owner = this.controller.owner;
    return { health: owner.health, maxHealth: owner.maxHealth, armour: owner.armour, armourType: owner.armourType,
      selectedGun: this.controller.inventory.selectedGun, ammo: this.controller.inventory.ammo,
      state: owner.alive ? ClientState.Alive : ClientState.Dead, flags: 0 };
  }

  private draw(width: number, height: number, player: HudPlayerView, clockSeconds: number): void {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio)), pixelHeight = Math.max(1, Math.round(height * ratio));
    if (this.element.width !== pixelWidth || this.element.height !== pixelHeight) {
      this.element.width = pixelWidth;
      this.element.height = pixelHeight;
    }
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    this.drawDamage(context, width, height);
    const scale = height / HUD_HEIGHT;
    context.save();
    context.scale(scale, scale);
    if (player.state !== ClientState.Spectator && player.state !== ClientState.Editing) this.drawPlayerHud(context, player);
    context.restore();
    this.drawClock(context, width, height, clockSeconds);
  }

  private drawPlayerHud(context: CanvasRenderingContext2D, player: HudPlayerView): void {
    const dead = player.state === ClientState.Dead;
    const health = dead ? 0 : player.health;
    const healthColor = dead ? "#808080" : health <= 25 ? "#ff0000" : health <= 50 ? "#ff8000" : health <= 100 ? "#ffffff" : "#40c0ff";
    this.drawNativeText(context, String(health), ICON_X + ICON_SIZE + ICON_SPACE, ICON_TEXT_Y, healthColor, 2);
    this.drawIcon(context, Icon.Health, ICON_X, ICON_Y);
    if (dead) return;
    if (player.maxHealth > 100) {
      const healthWidth = this.measureNativeText(context, String(health), 2);
      this.drawNativeText(context, `/${player.maxHealth}`, ICON_X + ICON_SIZE + ICON_SPACE + healthWidth, ICON_TEXT_Y + FONT_HEIGHT, "#ffffff", 0.66);
    }
    if (player.armour > 0) {
      this.drawNativeText(context, String(player.armour), ICON_X + ICON_STEP + ICON_SIZE + ICON_SPACE, ICON_TEXT_Y, "#ffffff", 2);
      this.drawIcon(context, Icon.BlueArmour + Math.max(0, Math.min(2, player.armourType)), ICON_X + ICON_STEP, ICON_Y);
    }
    const gun = Math.max(0, Math.min(6, player.selectedGun));
    this.drawNativeText(context, String(player.ammo[gun] ?? 0), ICON_X + 2 * ICON_STEP + ICON_SIZE + ICON_SPACE, ICON_TEXT_Y, "#ffffff", 2);
    this.drawIcon(context, Icon.Fist + gun, ICON_X + 2 * ICON_STEP, ICON_Y);
    let objectiveX = ICON_X + 3 * ICON_STEP;
    if (this.controller.quadMilliseconds > 0) {
      this.drawIcon(context, Icon.Quad, objectiveX, ICON_Y);
      objectiveX += ICON_SIZE + ICON_SPACE;
    }
    const objective = this.objectiveIcon(player);
    if (objective !== undefined) {
      this.drawIcon(context, objective, objectiveX, ICON_Y);
      if (gameModeHas(this.multiplayer?.gameMode ?? 0, GameModeFlag.Collect)) {
        this.drawNativeText(context, String(player.flags), objectiveX + ICON_SIZE + ICON_SPACE, ICON_TEXT_Y, "#ffffff", 2);
      }
    }
  }

  private objectiveIcon(player: HudPlayerView): number | undefined {
    const mode = this.multiplayer?.gameMode ?? 0;
    if (gameModeHas(mode, GameModeFlag.Collect) && player.flags > 0) return Icon.Token;
    if (!gameModeHas(mode, GameModeFlag.Ctf) || player.clientNumber === undefined || !this.multiplayer) return undefined;
    const carried = this.multiplayer.ctfMode.flags.find((flag) => flag.owner === player.clientNumber);
    if (!carried) return undefined;
    if (gameModeHas(mode, GameModeFlag.Hold)) return Icon.NeutralFlag;
    const localTeam = this.multiplayer.players.get(this.multiplayer.clientNumber)?.team ?? "";
    const carriedTeam = carried.team === 1 ? "good" : "evil";
    return carriedTeam === localTeam ? Icon.BlueFlag : Icon.RedFlag;
  }

  private drawClock(context: CanvasRenderingContext2D, width: number, height: number, seconds: number): void {
    if (!this.multiplayer || (!this.multiplayer.connected && !this.multiplayer.isLocalGame)) return;
    const mins = Math.trunc(seconds / 60), remaining = seconds % 60;
    const clock = `${mins}:${String(remaining).padStart(2, "0")}`;
    context.save();
    context.textBaseline = "top";
    context.textAlign = "center";
    context.font = `${FONT_HEIGHT * 0.75}px Sauerbraten, sans-serif`;
    context.fillStyle = mins < 1 ? "#ffc040" : "#ffffff";
    this.drawOutlinedText(context, clock, width * 0.5, height * 0.03 - FONT_HEIGHT * 0.75 * 0.5);
    context.restore();
  }

  private drawDamage(context: CanvasRenderingContext2D, width: number, height: number): void {
    const remaining = this.damageUntil - performance.now();
    if (remaining <= 0 || !this.damage.complete) return;
    const alpha = 0.45 * Math.min(1, remaining / 125);
    context.save();
    context.globalAlpha = alpha;
    context.globalCompositeOperation = "screen";
    context.drawImage(this.damage, 0, 0, width, height);
    context.restore();
  }

  private drawIcon(context: CanvasRenderingContext2D, icon: number, x: number, y: number): void {
    if (!this.items.complete || !this.items.naturalWidth) return;
    const sourceWidth = this.items.naturalWidth / 4, sourceHeight = this.items.naturalHeight / 4;
    context.drawImage(this.items, icon % 4 * sourceWidth, Math.trunc(icon / 4) * sourceHeight, sourceWidth, sourceHeight,
      x, y, ICON_SIZE, ICON_SIZE);
  }

  private drawNativeText(context: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale: number): void {
    context.save();
    context.font = `${FONT_HEIGHT * scale}px Sauerbraten, sans-serif`;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillStyle = color;
    this.drawOutlinedText(context, text, x, y);
    context.restore();
  }

  private drawOutlinedText(context: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    context.lineJoin = "round";
    context.miterLimit = 2;
    context.lineWidth = Math.max(3, Number.parseFloat(context.font) / 12);
    context.strokeStyle = "rgba(0, 0, 0, 0.95)";
    context.strokeText(text, x, y);
    context.fillText(text, x, y);
  }

  private measureNativeText(context: CanvasRenderingContext2D, text: string, scale: number): number {
    context.save();
    context.font = `${FONT_HEIGHT * scale}px Sauerbraten, sans-serif`;
    const width = context.measureText(text).width;
    context.restore();
    return width;
  }

  private handle(event: WeaponEvent): void {
    if (event.type === "damage" && event.target === this.controller.owner) {
      const now = performance.now();
      this.damageUntil = Math.max(now, this.damageUntil) + Math.max(10, Math.min(100, event.amount)) * 7;
    }
    this.invalidate();
  }

  private readonly invalidate = (): void => {
    this.lastFrame = "";
    this.render();
  };
}

function loadImage(source: string, loaded: () => void): HTMLImageElement {
  const image = new Image();
  image.addEventListener("load", loaded);
  image.src = source;
  return image;
}
