import type { BrowserPhysicsInput } from "./PhysicsInput";
import type { BrowserWeaponInput } from "./WeaponInput";
import { loadTouchSettings, TOUCH_SETTINGS_CHANGED, touchControlsWanted, type TouchSettings } from "./TouchSettings";

type PointerRole = "move" | "look" | "fire" | "jump" | "escape" | "fullscreen";

export const TOUCH_ESCAPE_REQUESTED = "sauerweb-touch-escape-requested";

export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly orientationOverlay: HTMLDivElement;
  private readonly pads: Record<"move" | "look", HTMLDivElement>;
  private readonly thumbs: Record<"move" | "look", HTMLDivElement>;
  private readonly pointers = new Map<number, PointerRole>();
  private readonly pointerForRole = new Map<PointerRole, number>();
  private settings = loadTouchSettings();
  private gameplayEnabled = true;
  private externallyBlocked = false;
  private portraitBlocked = false;
  private spectatorMode = false;

  constructor(parent: HTMLElement, private readonly physics: BrowserPhysicsInput, private readonly weapons: BrowserWeaponInput) {
    this.root = document.createElement("div");
    this.root.className = "touch-controls";
    this.root.hidden = true;
    this.root.innerHTML = `<button class="touch-corner touch-escape" data-touch-control="escape" type="button" aria-label="Pause">ESC</button>
      <button class="touch-corner touch-fullscreen" data-touch-control="fullscreen" type="button" aria-label="Toggle fullscreen">
        <span></span></button>
      <button class="touch-action touch-jump" data-touch-control="jump" type="button">JUMP</button>
      <button class="touch-action touch-fire" data-touch-control="fire" type="button">FIRE</button>
      <div class="touch-stick touch-move" data-touch-control="move" aria-label="Movement joystick"><div></div></div>
      <div class="touch-stick touch-look" data-touch-control="look" aria-label="Aiming joystick"><div></div></div>`;
    this.orientationOverlay = document.createElement("div");
    this.orientationOverlay.className = "orientation-overlay";
    this.orientationOverlay.hidden = true;
    this.orientationOverlay.innerHTML = `<div class="rotate-phone" aria-hidden="true"><span></span></div><strong>Rotate your device</strong>
      <p>SauerWeb requires landscape mode to play.</p>`;
    parent.append(this.root, this.orientationOverlay);
    this.pads = { move: this.required(".touch-move"), look: this.required(".touch-look") };
    this.thumbs = { move: this.required(".touch-move > div"), look: this.required(".touch-look > div") };
    this.root.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerEnd, { passive: false });
    window.addEventListener("pointercancel", this.onPointerEnd, { passive: false });
    this.root.addEventListener("lostpointercapture", this.onLostPointerCapture);
    this.root.addEventListener("contextmenu", this.preventDefault);
    window.addEventListener("blur", this.clear);
    window.addEventListener("resize", this.onViewportChanged);
    window.addEventListener("orientationchange", this.onViewportChanged);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.syncVisibility();
  }

  get active(): boolean { return !this.root.hidden; }
  get preferred(): boolean { return touchControlsWanted(this.settings); }

  setGameplayEnabled(enabled: boolean): void { this.gameplayEnabled = enabled; this.syncVisibility(); }
  setBlocked(blocked: boolean): void { this.externallyBlocked = blocked; this.syncVisibility(); }
  setSpectatorMode(enabled: boolean): void {
    if (enabled === this.spectatorMode) return;
    this.spectatorMode = enabled;
    this.clear();
    this.root.classList.toggle("spectator", enabled);
  }

  dispose(): void {
    this.clear();
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerEnd);
    window.removeEventListener("pointercancel", this.onPointerEnd);
    this.root.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    this.root.removeEventListener("contextmenu", this.preventDefault);
    window.removeEventListener("blur", this.clear);
    window.removeEventListener("resize", this.onViewportChanged);
    window.removeEventListener("orientationchange", this.onViewportChanged);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    window.removeEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    document.documentElement.classList.remove("mobile-gameplay");
    document.documentElement.style.removeProperty("--mobile-hud-scale");
    this.root.remove();
    this.orientationOverlay.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.pointerType === "mouse" && event.button !== 0) return;
    const role = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-touch-control]")?.dataset.touchControl as PointerRole | undefined : undefined;
    if (!role || this.pointerForRole.has(role)) return;
    this.pointers.set(event.pointerId, role);
    this.pointerForRole.set(role, event.pointerId);
    try { (event.target as Element).setPointerCapture?.(event.pointerId); }
    catch { /* Window listeners retain tracking where WebKit rejects capture. */ }
    if (role === "move" || role === "look") this.updateStick(role, event);
    else if (role === "fire") { this.weapons.setTouchAttacking(true); this.setPressed(role, true); }
    else if (role === "jump") { this.physics.setTouchJumping(true); this.setPressed(role, true); }
    else if (role === "escape") { this.setPressed(role, true); window.dispatchEvent(new Event(TOUCH_ESCAPE_REQUESTED)); }
    else { this.setPressed(role, true); void this.toggleFullscreen(); }
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const role = this.pointers.get(event.pointerId);
    if (role !== "move" && role !== "look") return;
    this.updateStick(role, event);
    event.preventDefault();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.releasePointer(event.pointerId);
    event.preventDefault();
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => { this.releasePointer(event.pointerId); };
  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => { this.settings = event.detail; this.syncVisibility(); };
  private readonly onViewportChanged = (): void => { this.syncVisibility(); };
  private readonly onFullscreenChange = (): void => { this.updateFullscreenIcon(); this.clear(); this.syncVisibility(); };
  private readonly onVisibilityChange = (): void => { if (document.hidden) this.clear(); };
  private readonly preventDefault = (event: Event): void => { event.preventDefault(); };

  private updateStick(role: "move" | "look", event: PointerEvent): void {
    const bounds = this.pads[role].getBoundingClientRect();
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) / 2);
    const dx = event.clientX - (bounds.left + bounds.width / 2), dy = event.clientY - (bounds.top + bounds.height / 2);
    const length = Math.hypot(dx, dy), scale = length > radius ? radius / length : 1;
    let x = dx * scale / radius, y = dy * scale / radius;
    const deadzone = this.settings.movementDeadzone / 100;
    if (role === "move" && Math.hypot(x, y) < deadzone) x = y = 0;
    this.thumbs[role].style.transform = `translate(${x * 70}%, ${y * 70}%)`;
    if (role === "move") this.physics.setTouchMovement(x, y);
    else this.physics.setTouchLookVelocity(x, y);
  }

  private releasePointer(pointerId: number): void {
    const role = this.pointers.get(pointerId);
    if (!role) return;
    this.pointers.delete(pointerId);
    this.pointerForRole.delete(role);
    if (role === "move" || role === "look") {
      if (role === "move") this.physics.setTouchMovement(0, 0);
      else this.physics.setTouchLookVelocity(0, 0);
      this.thumbs[role].style.transform = "";
    } else if (role === "fire") this.weapons.setTouchAttacking(false);
    else if (role === "jump") this.physics.setTouchJumping(false);
    this.setPressed(role, false);
  }

  private readonly clear = (): void => {
    for (const pointerId of [...this.pointers.keys()]) this.releasePointer(pointerId);
    this.physics.clearTouch();
    this.weapons.setTouchAttacking(false);
  };

  private syncVisibility(): void {
    const touch = this.gameplayEnabled && this.preferred;
    const portrait = touch && this.isPortrait();
    if (portrait !== this.portraitBlocked) { this.portraitBlocked = portrait; if (portrait) this.clear(); }
    this.orientationOverlay.hidden = !portrait;
    const visible = touch && !this.externallyBlocked && !portrait;
    if (visible && document.pointerLockElement) void document.exitPointerLock();
    if (!visible && !this.root.hidden) this.clear();
    this.root.hidden = !visible;
    this.root.style.setProperty("--touch-scale", String(this.settings.controlSize / 100));
    this.root.style.setProperty("--touch-opacity", String(this.settings.controlOpacity / 100));
    document.documentElement.style.setProperty("--mobile-hud-scale", String(this.settings.mobileHudScale / 100));
    document.documentElement.classList.toggle("mobile-gameplay", touch);
    this.updateFullscreenIcon();
  }

  private isPortrait(): boolean {
    const orientationType = screen.orientation?.type;
    if (orientationType) return orientationType.startsWith("portrait");
    return window.innerHeight > window.innerWidth;
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      if (document.fullscreenElement) await lockLandscape();
    } catch { /* Fullscreen and orientation locking are optional browser capabilities. */ }
  }

  private updateFullscreenIcon(): void { this.root.classList.toggle("is-fullscreen", Boolean(document.fullscreenElement)); }
  private setPressed(role: PointerRole, pressed: boolean): void {
    this.root.querySelector<HTMLElement>(`[data-touch-control='${role}']`)?.classList.toggle("pressed", pressed);
  }
  private required<T extends Element>(selector: string): T { return this.root.querySelector<T>(selector)!; }
}

export async function requestMobileLandscapeFullscreen(): Promise<void> {
  if (!touchControlsWanted()) return;
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    await lockLandscape();
  } catch { /* The in-game portrait overlay remains the fallback. */ }
}

export async function releaseMobileOrientation(): Promise<void> {
  try { screen.orientation?.unlock(); } catch { /* Unsupported on iOS and some embedded browsers. */ }
}

async function lockLandscape(): Promise<void> {
  const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
  try { await orientation?.lock?.("landscape"); } catch { /* Portrait overlay enforces landscape when locking is rejected. */ }
}
