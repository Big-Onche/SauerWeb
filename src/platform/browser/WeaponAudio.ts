import { SoundSystem, type MapSoundConfig } from "../../engine/sound";
import type { RegisteredMapEntity, Vec3 } from "../../engine/octa";
import type { MultiplayerClient, MultiplayerEvent } from "../../fpsgame/client";
import { GameSound, registerGameSounds } from "../../fpsgame/sound";
import { Gun } from "../../fpsgame/weapon/WeaponDefinitions";
import type { Damageable } from "../../fpsgame/weapon/DamageSystem";
import type { PhysicsEntity } from "../../engine/physics/types";
import type { PhysicsSoundEvent } from "../../engine/physics";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";
import { BrowserSoundBackend } from "./sound";

const SHOT_SOUNDS: Partial<Record<Gun, GameSound>> = {
  [Gun.Fist]: GameSound.Punch1,
  [Gun.Shotgun]: GameSound.Shotgun,
  [Gun.Chaingun]: GameSound.Chaingun,
  [Gun.Rocket]: GameSound.RocketFire,
  [Gun.Rifle]: GameSound.Rifle,
  [Gun.Grenade]: GameSound.FireballLaunch,
  [Gun.Pistol]: GameSound.Pistol,
  [Gun.Fireball]: GameSound.FireballLaunch,
  [Gun.Iceball]: GameSound.Iceball,
  [Gun.Slimeball]: GameSound.Slimeball,
  [Gun.Bite]: GameSound.PigGrunt1,
};

export class GameAudio {
  private readonly sound = new SoundSystem(new BrowserSoundBackend());
  private readonly unsubscribeWeapon: () => void;
  private readonly onMultiplayer = (event: Event): void => this.handleMultiplayer((event as CustomEvent<MultiplayerEvent>).detail);
  private entities: readonly RegisteredMapEntity[] = [];
  private mapSounds: readonly MapSoundConfig[] = [];

  constructor(events: WeaponEvents, private readonly multiplayer: MultiplayerClient, private readonly localPlayer: Damageable) {
    registerGameSounds(this.sound);
    this.unsubscribeWeapon = events.on((event) => this.handleWeapon(event));
    multiplayer.addEventListener("multiplayer", this.onMultiplayer);
  }

  setMap(entities: readonly RegisteredMapEntity[], mapSounds: readonly MapSoundConfig[] = []): void {
    this.entities = entities;
    this.mapSounds = mapSounds;
    this.sound.setMap(entities, mapSounds);
  }

  update(listener: Vec3, yaw: number): void {
    this.sound.setListener(listener, yaw);
    this.sound.updatesounds();
  }

  physicsSound(event: PhysicsSoundEvent, player: PhysicsEntity): void {
    const sounds: Record<PhysicsSoundEvent, GameSound> = { jump: GameSound.Jump, land: GameSound.Land, "splash-in": GameSound.Splash1,
      "splash-out": GameSound.Splash2, burn: GameSound.Burn };
    this.playsound(sounds[event], player === this.localPlayer ? undefined : player.position);
  }

  dispose(): void {
    this.unsubscribeWeapon();
    this.multiplayer.removeEventListener("multiplayer", this.onMultiplayer);
    this.sound.stopsounds();
  }

  private handleWeapon(event: WeaponEvent): void {
    if (event.type === "shot") this.playsound(SHOT_SOUNDS[event.gun]);
    else if (event.type === "shot-effect" && event.clientNumber !== this.multiplayer.clientNumber) {
      this.playsound(SHOT_SOUNDS[event.gun], event.from);
    } else if (event.type === "selected") this.playsound(GameSound.WeaponLoad);
    else if (event.type === "no-ammo") this.playsound(GameSound.NoAmmo);
    else if (event.type === "explosion") this.playsound(event.gun === Gun.Rocket ? GameSound.RocketHit : GameSound.FireballExplode,
      event.position);
    else if (event.type === "damage" && event.target.health > 0) {
      const local = event.target === this.localPlayer;
      this.playsound(local ? GameSound.Pain6 : GameSound.Pain1 + Math.floor(Math.random() * 5), local ? undefined : event.target.position);
    } else if (event.type === "death") {
      const local = event.target === this.localPlayer;
      this.playsound(GameSound.Die1 + Math.floor(Math.random() * 2), local ? undefined : event.target.position);
    }
  }

  private handleMultiplayer(event: MultiplayerEvent): void {
    if (event.type === "playsound") this.sound.playsound(event.sound, { loc: event.position });
    if (event.type !== "entity-effect") return;
    if (event.effect.type === "teleport") {
      const source = this.entities[event.effect.teleport], destination = this.entities[event.effect.teledest];
      if (!source || (source.attributes[3] ?? 0) < 0) return;
      this.playEntitySound(source, GameSound.Teleport, event.local ? undefined : source.position);
      if (!event.local && destination) this.playEntitySound(source, GameSound.Teleport, destination.position);
    } else {
      const source = this.entities[event.effect.jumppad];
      if (source && (source.attributes[3] ?? 0) >= 0) this.playEntitySound(source, GameSound.JumpPad, event.local ? undefined : source.position);
    }
  }

  private playEntitySound(entity: RegisteredMapEntity, fallback: GameSound, position?: Vec3): void {
    const mapSoundIndex = entity.attributes[3] ?? 0, config = mapSoundIndex > 0 ? this.mapSounds[mapSoundIndex] : undefined;
    if (config) this.sound.playsound(config.path, { loc: position });
    else this.sound.playsound(fallback, { loc: position });
  }

  private playsound(sound: GameSound | number | undefined, position?: Vec3): void {
    if (sound !== undefined) this.sound.playsound(sound, { loc: position });
  }
}

/** Compatibility name for the original weapon-only browser adapter. */
export { GameAudio as WeaponAudio };
