import { Gun } from "../../fpsgame/weapon/WeaponDefinitions";
import type { WeaponController } from "../../fpsgame/weapon/WeaponController";

export class BrowserWeaponInput {
  enabled = false;
  private mouseAttacking = false;
  private touchAttacking = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly controller: WeaponController) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.clear);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.clear();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0 || document.pointerLockElement !== this.canvas) return;
    this.mouseAttacking = true;
    this.syncAttacking();
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) {
      this.mouseAttacking = false;
      this.syncAttacking();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.repeat) return;
    const gun = numberKeyGun(event.code);
    if (gun === undefined) return;
    this.controller.select(gun);
    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.canvas || event.deltaY === 0) return;
    this.controller.cycle(event.deltaY > 0 ? 1 : -1);
    event.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) this.clear();
  };

  setTouchAttacking(attacking: boolean): void {
    this.touchAttacking = attacking;
    this.syncAttacking();
  }

  private readonly clear = (): void => {
    this.mouseAttacking = this.touchAttacking = false;
    this.syncAttacking();
  };

  private syncAttacking(): void { this.controller.setAttacking(this.enabled && (this.mouseAttacking || this.touchAttacking)); }
}

function numberKeyGun(code: string): Gun | undefined {
  const value = Number.parseInt(code.replace("Digit", ""), 10);
  return value >= 1 && value <= 7 ? value - 1 as Gun : undefined;
}
