import type { BrowserPhysicsInput } from "./PhysicsInput";
import type { BrowserWeaponInput } from "./WeaponInput";
import { loadTouchSettings, TOUCH_SETTINGS_CHANGED, touchControlsWanted, type TouchSettings } from "./TouchSettings";

type PointerRole = "move" | "look" | "fire" | "jump";

export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly movementPad: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly pointers = new Map<number, PointerRole>();
  private settings = loadTouchSettings();
  private gameplayEnabled = true;
  private blocked = false;
  private movePointer: number | undefined;
  private firePointer: number | undefined;
  private jumpPointer: number | undefined;
  private moveOrigin = { x: 0, y: 0 };
  private lookPositions = new Map<number, { x: number; y: number }>();

  constructor(parent: HTMLElement, private readonly physics: BrowserPhysicsInput, private readonly weapons: BrowserWeaponInput) {
    this.root = document.createElement("div");
    this.root.className = "touch-controls";
    this.root.hidden = true;
    this.root.innerHTML = `<div class="touch-stick" data-touch-control="move" aria-label="Movement joystick"><div></div></div>
      <button class="touch-button touch-jump" data-touch-control="jump" type="button" aria-label="Jump">↑</button>
      <button class="touch-button touch-fire" data-touch-control="fire" type="button" aria-label="Fire"><span></span></button>`;
    parent.append(this.root);
    this.movementPad = this.root.querySelector<HTMLDivElement>(".touch-stick")!;
    this.stick = this.root.querySelector<HTMLDivElement>(".touch-stick > div")!;
    this.root.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove, { passive: false });
    window.addEventListener("pointerup", this.onPointerEnd, { passive: false });
    window.addEventListener("pointercancel", this.onPointerEnd, { passive: false });
    this.root.addEventListener("lostpointercapture", this.onLostPointerCapture);
    window.addEventListener("blur", this.clear);
    window.addEventListener("resize", this.onViewportChanged);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.syncVisibility();
  }

  get active(): boolean { return !this.root.hidden; }

  get preferred(): boolean { return touchControlsWanted(this.settings); }

  setGameplayEnabled(enabled: boolean): void {
    this.gameplayEnabled = enabled;
    this.syncVisibility();
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    this.syncVisibility();
  }

  dispose(): void {
    this.clear();
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerEnd);
    window.removeEventListener("pointercancel", this.onPointerEnd);
    this.root.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    window.removeEventListener("blur", this.clear);
    window.removeEventListener("resize", this.onViewportChanged);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.root.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.pointerType === "mouse" && event.button !== 0) return;
    const control = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-touch-control]")?.dataset.touchControl : undefined;
    const bounds = this.root.getBoundingClientRect();
    const role = control === "move" || control === "fire" || control === "jump" ? control
      : event.clientX >= bounds.left + bounds.width / 2 ? "look" : undefined;
    if (!role) return;
    if (role === "move" && this.movePointer !== undefined || role === "fire" && this.firePointer !== undefined ||
        role === "jump" && this.jumpPointer !== undefined) return;
    this.pointers.set(event.pointerId, role);
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      // WebKit can reject capture for a pointer that started on a button. Window-level
      // move/end listeners still keep every pointer tracked until it is released.
    }
    if (role === "move") {
      this.movePointer = event.pointerId;
      const movementBounds = this.movementPad.getBoundingClientRect();
      this.moveOrigin = { x: movementBounds.left + movementBounds.width / 2, y: movementBounds.top + movementBounds.height / 2 };
      this.updateMovement(event);
    } else if (role === "look") {
      this.lookPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });
    } else if (role === "fire") {
      this.firePointer = event.pointerId;
      this.weapons.setTouchAttacking(true);
      this.setPressed("fire", true);
    } else {
      this.jumpPointer = event.pointerId;
      this.physics.setTouchJumping(true);
      this.setPressed("jump", true);
    }
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const role = this.pointers.get(event.pointerId);
    if (role === "move") this.updateMovement(event);
    else if (role === "look") {
      const previous = this.lookPositions.get(event.pointerId);
      if (previous) {
        const scale = this.settings.touchSensitivity / 100;
        this.physics.addTouchLook((event.clientX - previous.x) * scale, (event.clientY - previous.y) * scale);
      }
      this.lookPositions.set(event.pointerId, { x: event.clientX, y: event.clientY });
    } else return;
    event.preventDefault();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.releasePointer(event.pointerId);
    event.preventDefault();
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => { this.releasePointer(event.pointerId); };

  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => {
    this.settings = event.detail;
    if (this.preferred && document.pointerLockElement) void document.exitPointerLock();
    this.syncVisibility();
  };

  private readonly onViewportChanged = (): void => { this.syncVisibility(); };

  private readonly onVisibilityChange = (): void => { if (document.hidden) this.clear(); };

  private updateMovement(event: PointerEvent): void {
    const radius = Math.max(30, this.movementPad.clientWidth / 2);
    const dx = event.clientX - this.moveOrigin.x, dy = event.clientY - this.moveOrigin.y;
    const scale = Math.min(1, radius / Math.max(radius, Math.hypot(dx, dy)));
    const x = dx * scale / radius, y = dy * scale / radius;
    this.stick.style.transform = `translate(${x * 42}%, ${y * 42}%)`;
    this.physics.setTouchMovement(x, y);
  }

  private releasePointer(pointerId: number): void {
    const role = this.pointers.get(pointerId);
    if (!role) return;
    this.pointers.delete(pointerId);
    if (role === "move") {
      this.movePointer = undefined;
      this.physics.setTouchMovement(0, 0);
      this.stick.style.transform = "";
    } else if (role === "look") this.lookPositions.delete(pointerId);
    else if (role === "fire") {
      this.firePointer = undefined;
      this.weapons.setTouchAttacking(false);
      this.setPressed("fire", false);
    } else {
      this.jumpPointer = undefined;
      this.physics.setTouchJumping(false);
      this.setPressed("jump", false);
    }
  }

  private readonly clear = (): void => {
    for (const pointerId of this.pointers.keys()) {
      try {
        if (this.root.hasPointerCapture(pointerId)) this.root.releasePointerCapture(pointerId);
      } catch {
        // Capture may already have been discarded during blur or page suspension.
      }
    }
    this.pointers.clear();
    this.lookPositions.clear();
    this.movePointer = this.firePointer = this.jumpPointer = undefined;
    this.physics.clearTouch();
    this.weapons.setTouchAttacking(false);
    this.stick.style.transform = "";
    this.setPressed("fire", false);
    this.setPressed("jump", false);
  };

  private syncVisibility(): void {
    const visible = this.gameplayEnabled && !this.blocked && touchControlsWanted(this.settings);
    if (visible && document.pointerLockElement) void document.exitPointerLock();
    if (visible === !this.root.hidden) return;
    if (!visible) this.clear();
    this.root.hidden = !visible;
  }

  private setPressed(control: "fire" | "jump", pressed: boolean): void {
    this.root.querySelector<HTMLElement>(`[data-touch-control='${control}']`)?.classList.toggle("pressed", pressed);
  }
}
