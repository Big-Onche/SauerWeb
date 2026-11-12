import type { RegisteredMapEntity, Vec3 } from "./octa";

export interface SoundSource {
  readonly playing: boolean;
  update(volume: number, pan: number): void;
  stop(): void;
}

export interface SoundBackend {
  play(path: string, loops: number): SoundSource | undefined;
}

export interface SoundSlot { path: string; volume: number }
export interface SoundConfig { slots: SoundSlot[]; maxUses: number }
export interface PlaySoundOptions { loc?: Vec3; radius?: number; loops?: number; channelId?: number }
export interface MapSoundConfig { path: string; volume: number; maxUses: number }

interface SoundChannel {
  id: number;
  config: number | string;
  slot: SoundSlot;
  source: SoundSource;
  loc?: Vec3;
  entity?: RegisteredMapEntity;
  radius: number;
  volume: number;
  pan: number;
}

const DEFAULT_MAX_RADIUS = 340;

// Original: src/engine/sound.cpp
// Functions/types: soundslot, soundconfig, soundchannel, playsound(), updatechannel(), checkmapsounds(), updatesounds()
// Sauerbraten reference: SVN r6488
export class SoundSystem {
  soundVolume = 255;
  stereo = true;
  maxChannels = 128;
  maxSoundsAtOnce = 7;
  maxSoundRadius = DEFAULT_MAX_RADIUS;
  private readonly configs = new Map<number | string, SoundConfig>();
  private readonly channels: Array<SoundChannel | undefined> = [];
  private mapSounds: readonly MapSoundConfig[] = [];
  private mapEntities: readonly RegisteredMapEntity[] = [];
  private listener: Vec3 = { x: 0, y: 0, z: 0 };
  private listenerYaw = 0;
  private soundsAtOnce = 0;
  private lastSoundMillis = Number.NEGATIVE_INFINITY;

  constructor(private readonly backend: SoundBackend) {}

  registersound(id: number | string, path: string, volume = 100, maxUses = 0): void {
    const config = this.configs.get(id), slot = { path, volume };
    if (config) config.slots.push(slot);
    else this.configs.set(id, { slots: [slot], maxUses });
  }

  setMap(entities: readonly RegisteredMapEntity[], sounds: readonly MapSoundConfig[] = []): void {
    this.stopmapsounds();
    this.mapEntities = entities;
    this.mapSounds = sounds;
  }

  setListener(position: Vec3, yaw: number): void {
    this.listener = { ...position };
    this.listenerYaw = yaw;
  }

  playsound(id: number | string, options: PlaySoundOptions = {}): number {
    if (!this.soundVolume) return -1;
    const config = this.configs.get(id) ?? (typeof id === "string" ? { slots: [{ path: id, volume: 100 }], maxUses: 0 } : undefined);
    if (!config) return -1;
    let radius = options.radius ?? this.maxSoundRadius;
    if (options.loc) {
      radius = Math.min(radius > 0 ? radius : this.maxSoundRadius, this.maxSoundRadius);
      if (distance(this.listener, options.loc) > 1.5 * radius) {
        if (options.channelId !== undefined) this.stopchannel(options.channelId);
        return -1;
      }
    }
    if (options.channelId !== undefined && options.channelId >= 0) {
      const current = this.channels[options.channelId];
      if (current?.config === id && current.source.playing) {
        current.loc = options.loc ? { ...options.loc } : undefined;
        return current.id;
      }
    }
    if (config.maxUses && this.channels.filter((channel) => channel?.config === id && channel.source.playing).length >= config.maxUses) return -1;
    const now = Math.trunc(performance.now());
    this.soundsAtOnce = now === this.lastSoundMillis ? this.soundsAtOnce + 1 : 1;
    this.lastSoundMillis = now;
    if (this.maxSoundsAtOnce && this.soundsAtOnce > this.maxSoundsAtOnce) return -1;
    const slot = config.slots[Math.floor(Math.random() * config.slots.length)], source = this.backend.play(slot.path, options.loops ?? 0);
    if (!source) return -1;
    const channelId = this.allocatechannel(options.channelId);
    if (channelId < 0) { source.stop(); return -1; }
    const channel: SoundChannel = { id: channelId, config: id, slot, source, loc: options.loc ? { ...options.loc } : undefined,
      radius, volume: -1, pan: -1 };
    this.channels[channelId] = channel;
    this.updatechannel(channel);
    return channelId;
  }

  updatesounds(): void {
    this.reclaimchannels();
    this.checkmapsounds();
    for (const channel of this.channels) if (channel?.loc) this.updatechannel(channel);
  }

  stopsounds(): void {
    for (let index = 0; index < this.channels.length; index++) this.stopchannel(index);
  }

  stopmapsounds(): void {
    for (let index = 0; index < this.channels.length; index++) if (this.channels[index]?.entity) this.stopchannel(index);
  }

  private checkmapsounds(): void {
    for (const entity of this.mapEntities) {
      if (entity.typeName !== "sound") continue;
      const channel = this.channels.find((candidate) => candidate?.entity === entity), radius = entity.attributes[1] ?? 0;
      if (distance(this.listener, entity.position) < radius) {
        if (!channel) this.playmapsound(entity);
      } else if (channel) this.stopchannel(channel.id);
    }
  }

  private playmapsound(entity: RegisteredMapEntity): void {
    const config = this.mapSounds[entity.attributes[0] ?? -1];
    if (!config) return;
    const configId = `map:${entity.attributes[0]}`;
    if (config.maxUses && this.channels.filter((channel) => channel?.config === configId && channel.source.playing).length >= config.maxUses) return;
    const source = this.backend.play(config.path, -1), id = this.allocatechannel();
    if (!source || id < 0) { source?.stop(); return; }
    const slot = { path: config.path, volume: entity.attributes[3] > 0 ? entity.attributes[3] : config.volume };
    const channel: SoundChannel = { id, config: configId, slot, source, loc: { ...entity.position }, entity,
      radius: entity.attributes[1] ?? 0, volume: -1, pan: -1 };
    this.channels[id] = channel;
    this.updatechannel(channel);
  }

  private updatechannel(channel: SoundChannel): void {
    let volume = this.soundVolume, pan = 0;
    if (channel.loc) {
      const dx = channel.loc.x - this.listener.x, dy = channel.loc.y - this.listener.y;
      let dist = Math.hypot(dx, dy, channel.loc.z - this.listener.z), radius = channel.radius;
      if (channel.entity) {
        radius = channel.entity.attributes[1] ?? 0;
        const innerRadius = channel.entity.attributes[2] ?? 0;
        if (innerRadius) { radius -= innerRadius; dist -= innerRadius; }
      }
      if (radius > 0) volume -= clamp(dist / radius, 0, 1) * this.soundVolume;
      if (this.stereo && (dx || dy) && dist > 0) {
        const yaw = -this.listenerYaw * Math.PI / 180, rotatedX = dx * Math.cos(yaw) - dy * Math.sin(yaw);
        pan = clamp(-rotatedX / Math.hypot(dx, dy), -1, 1);
      }
    }
    volume = Math.min(1, volume * channel.slot.volume / (255 * 255));
    if (volume === channel.volume && pan === channel.pan) return;
    channel.volume = volume;
    channel.pan = pan;
    channel.source.update(volume, pan);
  }

  private allocatechannel(preferred = -1): number {
    if (preferred >= 0 && preferred < this.maxChannels) { this.stopchannel(preferred); return preferred; }
    const free = this.channels.findIndex((channel) => !channel);
    if (free >= 0) return free;
    if (this.channels.length < this.maxChannels) return this.channels.length;
    const silent = this.channels.findIndex((channel) => channel?.volume === 0);
    if (silent >= 0) { this.stopchannel(silent); return silent; }
    return -1;
  }

  private reclaimchannels(): void {
    for (let index = 0; index < this.channels.length; index++) if (this.channels[index] && !this.channels[index]?.source.playing) {
      this.channels[index]?.source.stop();
      this.channels[index] = undefined;
    }
  }

  private stopchannel(id: number): void {
    this.channels[id]?.source.stop();
    this.channels[id] = undefined;
  }
}

function distance(left: Vec3, right: Vec3): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
