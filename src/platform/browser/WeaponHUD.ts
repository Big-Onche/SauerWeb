import { WEAPONS } from "../../fpsgame/weapon/WeaponDefinitions";
import type { WeaponController } from "../../fpsgame/weapon/WeaponController";
import type { WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";

export class WeaponHUD {
  readonly element: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly controller: WeaponController, events: WeaponEvents) {
    this.element = document.createElement("div");
    this.element.className = "weapon-hud";
    parent.append(this.element);
    events.on(() => this.render());
    this.render();
  }

  render(view?: { health: number; selectedGun: number; ammo: ArrayLike<number> }): void {
    const gun = Math.max(0, Math.min(WEAPONS.length - 1, view?.selectedGun ?? this.controller.inventory.selectedGun));
    const health = view?.health ?? this.controller.owner.health;
    const ammo = view?.ammo ?? this.controller.inventory.ammo;
    this.element.innerHTML = `<span class="weapon-health">${Math.max(0, health)}</span><span class="weapon-name">${WEAPONS[gun].name}</span>` +
      `<strong class="weapon-ammo">${gun === 0 ? "∞" : ammo[gun]}</strong>`;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }
}
