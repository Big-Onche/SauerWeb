import { AMMO_PICKUPS, GUN_COUNT, Gun, PLAYER_GUN_COUNT } from "./WeaponDefinitions";
import { GameModeFlag, gameModeHas } from "../game";

export class WeaponInventory {
  readonly ammo = new Int32Array(GUN_COUNT);
  selectedGun = Gun.Pistol;

  constructor() {
    this.respawn();
  }

  respawn(): void {
    this.ammo.fill(0);
    this.ammo[Gun.Fist] = 1;
    this.ammo[Gun.Pistol] = 40;
    this.ammo[Gun.Grenade] = 1;
    this.selectedGun = Gun.Pistol;
  }

  spawnForGameMode(mode: number, random: () => number = Math.random): void {
    this.ammo.fill(0);
    this.ammo[Gun.Fist] = 1;
    this.selectedGun = Gun.Pistol;
    if (gameModeHas(mode, GameModeFlag.Insta)) {
      this.selectedGun = Gun.Rifle;
      this.ammo[Gun.Rifle] = 100;
    } else if (gameModeHas(mode, GameModeFlag.Tactics)) {
      this.ammo[Gun.Pistol] = 40;
      const first = Gun.Shotgun + Math.floor(random() * 5);
      let second = Gun.Shotgun + Math.floor(random() * 5);
      while (second === first) second = Gun.Shotgun + Math.floor(random() * 5);
      this.selectedGun = first;
      this.grantBaseAmmo(first, gameModeHas(mode, GameModeFlag.NoItems) ? 2 : 1);
      this.grantBaseAmmo(second, gameModeHas(mode, GameModeFlag.NoItems) ? 2 : 1);
      if (gameModeHas(mode, GameModeFlag.NoItems)) this.ammo[Gun.Grenade]++;
    } else if (gameModeHas(mode, GameModeFlag.Efficiency)) {
      for (let gun = Gun.Shotgun; gun <= Gun.Grenade; gun++) this.grantBaseAmmo(gun, 2);
      this.selectedGun = Gun.Chaingun;
      this.ammo[Gun.Chaingun] = Math.floor(this.ammo[Gun.Chaingun] / 2);
    } else {
      this.ammo[Gun.Pistol] = 40;
      this.ammo[Gun.Grenade] = 1;
    }
  }

  grantMaximumAmmo(): void {
    this.ammo[Gun.Fist] = 1;
    AMMO_PICKUPS.forEach((pickup, index) => {
      this.ammo[Gun.Shotgun + index] = pickup.max;
    });
  }

  hasAmmo(gun: Gun): boolean {
    return gun >= Gun.Fist && gun < GUN_COUNT && this.ammo[gun] > 0;
  }

  consume(gun: Gun): boolean {
    if (!this.hasAmmo(gun)) return false;
    if (gun !== Gun.Fist) this.ammo[gun]--;
    return true;
  }

  select(gun: Gun, force = false): boolean {
    if (gun < Gun.Fist || gun >= PLAYER_GUN_COUNT || (!force && !this.hasAmmo(gun))) return false;
    this.selectedGun = gun;
    return true;
  }

  cycle(direction: number, force = false): Gun | undefined {
    const step = direction < 0 ? PLAYER_GUN_COUNT - 1 : 1;
    let gun = this.selectedGun;
    for (let index = 0; index < PLAYER_GUN_COUNT; index++) {
      gun = (gun + step) % PLAYER_GUN_COUNT;
      if (force || this.hasAmmo(gun)) return gun;
    }
    return undefined;
  }

  automaticSwitch(): Gun {
    const order = [Gun.Chaingun, Gun.Rocket, Gun.Shotgun, Gun.Rifle, Gun.Grenade, Gun.Pistol];
    return order.find((gun) => gun !== this.selectedGun && this.hasAmmo(gun)) ?? Gun.Fist;
  }

  private grantBaseAmmo(gun: Gun, multiplier: number): void {
    const pickup = AMMO_PICKUPS[gun - Gun.Shotgun];
    if (pickup) this.ammo[gun] = pickup.add * multiplier;
  }
}
