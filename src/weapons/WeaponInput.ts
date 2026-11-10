import { Gun } from "./WeaponDefinitions";
import type { WeaponController } from "./WeaponController";

export class BrowserWeaponInput {
  enabled = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly controller: WeaponController) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("blur", this.clear);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0 || document.pointerLockElement !== this.canvas) return;
    this.controller.setAttacking(true);
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) this.controller.setAttacking(false);
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

  private readonly clear = (): void => {
    this.controller.setAttacking(false);
  };
}

function numberKeyGun(code: string): Gun | undefined {
  const value = Number.parseInt(code.replace("Digit", ""), 10);
  return value >= 1 && value <= 7 ? value - 1 as Gun : undefined;
}
