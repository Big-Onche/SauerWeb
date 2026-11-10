import { WEAPONS } from "./WeaponDefinitions";
import type { WeaponController } from "./WeaponController";
import type { WeaponEvents } from "./WeaponEvents";

export class WeaponHUD {
  readonly element: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly controller: WeaponController, events: WeaponEvents) {
    this.element = document.createElement("div");
    this.element.className = "weapon-hud";
    parent.append(this.element);
    events.on(() => this.render());
    this.render();
  }

  render(): void {
    const gun = this.controller.inventory.selectedGun;
    const owner = this.controller.owner;
    this.element.innerHTML = `<span class="weapon-health">${Math.max(0, owner.health)}</span><span class="weapon-name">${WEAPONS[gun].name}</span>` +
      `<strong class="weapon-ammo">${gun === 0 ? "∞" : this.controller.inventory.ammo[gun]}</strong>`;
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
  }
}
