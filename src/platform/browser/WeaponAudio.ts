import { SoundSystem } from "../../engine/sound";
import { Gun } from "../../fpsgame/weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";
import { BrowserSoundBackend } from "./sound";

const SHOT_SOUNDS: Partial<Record<Gun, string>> = {
  [Gun.Fist]: "sounds/free/punch1.wav",
  [Gun.Shotgun]: "sounds/q009/shotgun.ogg",
  [Gun.Chaingun]: "sounds/q009/minigun.ogg",
  [Gun.Rocket]: "sounds/q009/rlauncher.ogg",
  [Gun.Rifle]: "sounds/q009/rifle.ogg",
  [Gun.Grenade]: "sounds/q009/glauncher.ogg",
  [Gun.Pistol]: "sounds/q009/pistol.ogg",
};

export class WeaponAudio {
  private readonly sound = new SoundSystem(new BrowserSoundBackend());

  constructor(events: WeaponEvents) {
    events.on((event) => this.handle(event));
  }

  private handle(event: WeaponEvent): void {
    let path: string | undefined;
    if (event.type === "shot" || event.type === "shot-effect") path = SHOT_SOUNDS[event.gun];
    else if (event.type === "selected") path = "sounds/aard/weapload.wav";
    else if (event.type === "no-ammo") path = "sounds/aard/outofammo.wav";
    else if (event.type === "explosion") path = event.gun === Gun.Grenade ? "sounds/q009/grenade.ogg" : "sounds/q009/ren.ogg";
    if (!path) return;
    this.sound.playsound(path, 0.7);
  }
}
