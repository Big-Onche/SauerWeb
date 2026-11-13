import type { EntityCategory, MapEntity, RegisteredMapEntity, Vec3 } from "../engine/octa";
import type { PhysicsSimulation } from "../engine/physics";
import { ClientState, PhysicsState } from "../engine/physics/types";
import { magnitude } from "../engine/physics/vector";
import { GameModeFlag, gameModeHas } from "./game";

export const I_SHELLS = 8, I_BULLETS = 9, I_ROCKETS = 10, I_ROUNDS = 11, I_GRENADES = 12, I_CARTRIDGES = 13;
export const I_HEALTH = 14, I_BOOST = 15, I_GREENARMOUR = 16, I_YELLOWARMOUR = 17, I_QUAD = 18;

export const TELEPORT = 19;
export const TELEDEST = 20;
export const JUMPPAD = 23;

export type EntityEffect = { type: "teleport"; teleport: number; teledest: number } |
  { type: "jumppad"; jumppad: number };

export interface PickupState {
  health: number; maxHealth: number; armour: number; armourType: number; ammo: Int32Array; quadMillis: number;
}

export interface ItemState { spawned: boolean; noPickup: boolean; spawnAt: number; announced: boolean }
export interface ItemStat { add: number; max: number; name: string; info: number }

// Original: src/fpsgame/game.h, itemstats[]. Gun indices are GUN_SG..GUN_PISTOL (1..6).
export const ITEM_STATS: readonly ItemStat[] = [
  { add: 10, max: 30, name: "SG", info: 1 }, { add: 20, max: 60, name: "CG", info: 2 },
  { add: 5, max: 15, name: "RL", info: 3 }, { add: 5, max: 15, name: "RI", info: 4 },
  { add: 10, max: 30, name: "GL", info: 5 }, { add: 30, max: 120, name: "PI", info: 6 },
  { add: 25, max: 100, name: "H", info: -1 }, { add: 100, max: 200, name: "MH", info: 50 },
  { add: 100, max: 100, name: "GA", info: 1 }, { add: 200, max: 200, name: "YA", info: 2 },
  { add: 20_000, max: 30_000, name: "Q", info: -1 },
];
export const ITEM_ICONS = [6, 7, 8, 9, 10, 11, 4, 4, 1, 2, 13] as const;

export interface FpsEntityCallbacks {
  effect?: (effect: EntityEffect, local: boolean) => void;
  send?: (effect: EntityEffect) => void;
  warning?: (message: string) => void;
  canPickup?: (type: number) => boolean;
  requestPickup?: (entity: number) => void;
  announce?: (type: number) => void;
}

// Original: src/fpsgame/entities.cpp
// Functions: checkitems(), trypickup(), teleport(), teleporteffects(), jumppadeffects()
// Sauerbraten reference: SVN r6488
export class FpsEntities {
  ents: readonly RegisteredMapEntity[] = [];
  private lastpickup = -1;
  private lastpickupmillis = Number.NEGATIVE_INFINITY;
  private itemStates: ItemState[] = [];
  private gameMode = 0;

  constructor(private readonly physics: PhysicsSimulation, private readonly callbacks: FpsEntityCallbacks = {}) {}

  setMap(entities: readonly RegisteredMapEntity[], gameMode = this.gameMode, localAuthority = false, now = 0, playerCount = 1): void {
    this.ents = entities;
    this.gameMode = gameMode;
    this.itemStates = entities.map(() => ({ spawned: false, noPickup: false, spawnAt: 0, announced: false }));
    this.lastpickup = -1;
    this.lastpickupmillis = Number.NEGATIVE_INFINITY;
    if (localAuthority) this.spawnitems(false, now, playerCount);
  }

  setGameMode(gameMode: number): void { this.gameMode = gameMode; }
  itemState(index: number): Readonly<ItemState> | undefined { return this.itemStates[index]; }
  isSpawned(index: number): boolean { return this.itemStates[index]?.spawned === true; }

  resetspawns(): void {
    for (const state of this.itemStates) Object.assign(state, { spawned: false, noPickup: false, spawnAt: 0, announced: false });
  }

  spawnitems(force = false, now = 0, playerCount = 1): void {
    if (gameModeHas(this.gameMode, GameModeFlag.NoItems)) return;
    this.ents.forEach((entity, index) => {
      if (!canspawnitem(entity.type, this.gameMode)) return;
      const singlePlayer = gameModeHas(this.gameMode, GameModeFlag.ClassicSp) || gameModeHas(this.gameMode, GameModeFlag.Dmsp);
      const delayed = delayspawn(entity.type) && !singlePlayer;
      const spawned = force || singlePlayer || !delayed;
      Object.assign(this.itemStates[index], { spawned, noPickup: false, spawnAt: spawned ? 0 : now + spawntime(entity.type, playerCount), announced: false });
    });
  }

  setspawn(index: number, on: boolean): void {
    const state = this.itemStates[index];
    if (state) Object.assign(state, { spawned: on, noPickup: false, spawnAt: 0, announced: false });
  }

  updateLocalSpawns(now: number): number[] {
    const spawned: number[] = [];
    this.itemStates.forEach((state, index) => {
      const type = this.ents[index]?.type;
      if (!state.spawned && !state.announced && state.spawnAt - now <= 10_000 && state.spawnAt > now &&
          (type === I_BOOST || type === I_QUAD)) {
        state.announced = true;
        this.callbacks.announce?.(type);
      }
      if (!state.spawned && state.spawnAt > 0 && now >= state.spawnAt) {
        Object.assign(state, { spawned: true, noPickup: false, spawnAt: 0, announced: false });
        spawned.push(index);
      }
    });
    return spawned;
  }

  checkitems(lastmillis: number): void {
    const d = this.physics.player;
    if (!d.alive || d.clientState !== ClientState.Alive) return;
    const o = { ...d.position, z: d.position.z - d.eyeHeight };
    for (const e of this.ents) {
      const state = this.itemStates[e.index];
      if (e.type !== TELEPORT && e.type !== JUMPPAD && (!state?.spawned || state.noPickup)) continue;
      const dist = Math.hypot(e.position.x - o.x, e.position.y - o.y, e.position.z - o.z);
      if (dist < (e.type === TELEPORT ? 16 : 12)) this.trypickup(e.index, lastmillis);
    }
  }

  teleporteffects(tp: number, td: number, local = true): void {
    const effect: EntityEffect = { type: "teleport", teleport: tp, teledest: td };
    this.callbacks.effect?.(effect, local);
    if (local) this.callbacks.send?.(effect);
  }

  jumppadeffects(jp: number, local = true): void {
    const effect: EntityEffect = { type: "jumppad", jumppad: jp };
    this.callbacks.effect?.(effect, local);
    if (local) this.callbacks.send?.(effect);
  }

  optimisticPickup(index: number): void {
    const state = this.itemStates[index];
    if (state?.spawned) state.noPickup = true;
  }

  rejectPickup(index: number): void { this.setspawn(index, true); }

  acknowledgePickup(index: number): void {
    const state = this.itemStates[index];
    if (state) Object.assign(state, { spawned: false, noPickup: false, spawnAt: 0, announced: false });
  }

  tryLocalPickup(index: number, pickupState: PickupState, now: number, playerCount: number): boolean {
    const entity = this.ents[index], state = this.itemStates[index];
    if (!entity || !state?.spawned || state.noPickup || !canpickup(pickupState, entity.type)) return false;
    state.spawned = false;
    state.noPickup = false;
    state.announced = false;
    state.spawnAt = gameModeHas(this.gameMode, GameModeFlag.ClassicSp) ? Number.POSITIVE_INFINITY
      : now + spawntime(entity.type, playerCount);
    pickup(pickupState, entity.type);
    return true;
  }

  teleport(n: number): void {
    const d = this.physics.player, source = this.ents[n];
    if (!source || source.type !== TELEPORT) return;
    const tag = source.attributes[0] ?? 0;
    const e = this.ents.find((entity) => entity.type === TELEDEST && (entity.attributes[1] ?? 0) === tag);
    if (!e) {
      this.callbacks.warning?.(`no teleport destination for tag ${tag}`);
      return;
    }
    this.teleporteffects(n, e.index, true);
    d.yaw = e.attributes[0] ?? 0;
    if ((e.attributes[2] ?? 0) > 0) {
      const radians = d.yaw * Math.PI / 180, speed = Math.hypot(d.velocity.x, d.velocity.y);
      d.velocity.x = -Math.sin(radians) * speed;
      d.velocity.y = Math.cos(radians) * speed;
    } else d.velocity.x = d.velocity.y = d.velocity.z = 0;
    this.physics.entinmap(e.position);
  }

  private trypickup(n: number, lastmillis: number): void {
    const d = this.physics.player, e = this.ents[n];
    if (!e) return;
    switch (e.type) {
      default:
        if (this.callbacks.canPickup?.(e.type) ?? false) {
          this.callbacks.requestPickup?.(n);
          this.optimisticPickup(n);
        }
        break;
      case TELEPORT:
        if (this.lastpickup === e.type && lastmillis - this.lastpickupmillis < 500) break;
        this.lastpickup = e.type;
        this.lastpickupmillis = lastmillis;
        this.teleport(n);
        break;
      case JUMPPAD:
        if (this.lastpickup === e.type && lastmillis - this.lastpickupmillis < 300) break;
        this.lastpickup = e.type;
        this.lastpickupmillis = lastmillis;
        this.jumppadeffects(n, true);
        d.falling.x = d.falling.y = d.falling.z = 0;
        d.physicsState = PhysicsState.Fall;
        d.timeInAir = 1;
        d.velocity = {
          x: signedByte(e.attributes[2] ?? 0) * 10,
          y: signedByte(e.attributes[1] ?? 0) * 10,
          z: (e.attributes[0] ?? 0) * 12.5,
        };
        break;
    }
  }
}

export function canspawnitem(type: number, gameMode: number): boolean {
  return !gameModeHas(gameMode, GameModeFlag.NoItems) && type >= I_SHELLS && type <= I_QUAD &&
    (!gameModeHas(gameMode, GameModeFlag.NoAmmo) || type < I_SHELLS || type > I_CARTRIDGES);
}

export function delayspawn(type: number): boolean {
  return type === I_GREENARMOUR || type === I_YELLOWARMOUR || type === I_BOOST || type === I_QUAD;
}

export function spawntime(type: number, playerCount: number): number {
  const scale = playerCount < 3 ? 4 : playerCount > 4 ? 2 : 3;
  if (type >= I_SHELLS && type <= I_CARTRIDGES) return scale * 4_000;
  if (type === I_HEALTH) return scale * 5_000;
  if (type === I_GREENARMOUR) return 20_000;
  if (type === I_YELLOWARMOUR) return 30_000;
  if (type === I_BOOST) return 60_000;
  if (type === I_QUAD) return 70_000;
  return 0;
}

// Original: src/fpsgame/game.h, fpsstate::canpickup() / pickup().
export function canpickup(state: PickupState, type: number): boolean {
  if (type < I_SHELLS || type > I_QUAD) return false;
  const stat = ITEM_STATS[type - I_SHELLS];
  switch (type) {
    case I_BOOST: return state.maxHealth < stat.max || state.health < state.maxHealth;
    case I_HEALTH: return state.health < state.maxHealth;
    case I_GREENARMOUR:
      if (state.armourType === 2 && state.armour >= 100) return false;
    case I_YELLOWARMOUR: return !state.armourType || state.armour < stat.max;
    case I_QUAD: return state.quadMillis < stat.max;
    default: return state.ammo[stat.info] < stat.max;
  }
}

export function pickup(state: PickupState, type: number): void {
  if (type < I_SHELLS || type > I_QUAD) return;
  const stat = ITEM_STATS[type - I_SHELLS];
  switch (type) {
    case I_BOOST:
      state.maxHealth = Math.min(state.maxHealth + stat.info, stat.max);
    case I_HEALTH:
      state.health = Math.min(state.health + stat.add, state.maxHealth);
      break;
    case I_GREENARMOUR:
    case I_YELLOWARMOUR:
      state.armour = Math.min(state.armour + stat.add, stat.max);
      state.armourType = stat.info;
      break;
    case I_QUAD:
      state.quadMillis = Math.min(state.quadMillis + stat.add, stat.max);
      break;
    default:
      state.ammo[stat.info] = Math.min(state.ammo[stat.info] + stat.add, stat.max);
      break;
  }
}

interface FpsEntityDefinition {
  name: string;
  category: EntityCategory;
  attributes?: string[];
  yawAttribute?: number;
  mapModelAttribute?: number;
  direction?: (attributes: MapEntity["attributes"]) => Vec3;
}

const FPS_ENTITY_DEFINITIONS: FpsEntityDefinition[] = [
  { name: "empty", category: "empty" },
  { name: "light", category: "light", attributes: ["radius", "red", "green", "blue", "attr5"] },
  { name: "mapmodel", category: "mapmodel", attributes: ["yaw", "modelIndex", "triggerType", "triggerTag", "attr5"], yawAttribute: 0,
    mapModelAttribute: 1 },
  { name: "playerstart", category: "spawn", attributes: ["yaw", "team", "attr3", "attr4", "attr5"], yawAttribute: 0 },
  { name: "envmap", category: "effect", attributes: ["radius", "size", "blur", "attr4", "attr5"] },
  { name: "particles", category: "effect", attributes: ["particleType", "value1", "value2", "value3", "value4"] },
  { name: "sound", category: "sound", attributes: ["soundIndex", "radius", "size", "volume", "attr5"] },
  { name: "spotlight", category: "light", attributes: ["angle", "attr2", "attr3", "attr4", "attr5"] },
  { name: "shells", category: "pickup" },
  { name: "bullets", category: "pickup" },
  { name: "rockets", category: "pickup" },
  { name: "riflerounds", category: "pickup" },
  { name: "grenades", category: "pickup" },
  { name: "cartridges", category: "pickup" },
  { name: "health", category: "pickup" },
  { name: "healthboost", category: "pickup" },
  { name: "greenarmour", category: "pickup" },
  { name: "yellowarmour", category: "pickup" },
  { name: "quaddamage", category: "pickup" },
  { name: "teleport", category: "teleport", attributes: ["destinationTag", "modelIndex", "tag", "soundIndex", "attr5"] },
  { name: "teledest", category: "teleport", attributes: ["yaw", "tag", "attr3", "attr4", "attr5"], yawAttribute: 0 },
  { name: "monster", category: "gameplay", attributes: ["yaw", "monsterType", "attr3", "attr4", "attr5"], yawAttribute: 0 },
  { name: "carrot", category: "gameplay", attributes: ["tag", "carrotType", "attr3", "attr4", "attr5"] },
  { name: "jumppad", category: "movement", attributes: ["zPush", "yPush", "xPush", "attr4", "attr5"], direction: jumpPadDirection },
  { name: "base", category: "gameplay" },
  { name: "respawnpoint", category: "spawn", attributes: ["yaw", "team", "attr3", "attr4", "attr5"], yawAttribute: 0 },
  { name: "box", category: "gameplay", attributes: ["yaw", "modelIndex", "weight", "attr4", "attr5"], yawAttribute: 0,
    mapModelAttribute: 1 },
  { name: "barrel", category: "gameplay", attributes: ["yaw", "modelIndex", "weight", "health", "attr5"], yawAttribute: 0,
    mapModelAttribute: 1 },
  { name: "platform", category: "movement", attributes: ["yaw", "modelIndex", "tag", "speed", "attr5"], yawAttribute: 0,
    mapModelAttribute: 1 },
  { name: "elevator", category: "movement", attributes: ["yaw", "modelIndex", "tag", "speed", "attr5"], yawAttribute: 0,
    mapModelAttribute: 1 },
  { name: "flag", category: "gameplay", attributes: ["yaw", "team", "attr3", "attr4", "attr5"], yawAttribute: 0 },
];

// Original: src/fpsgame/entities.cpp
// Function: entities::readent() / entity registration
// Sauerbraten reference: SVN r6488
export function createFpsEntityRegistry(entities: MapEntity[]): RegisteredMapEntity[] {
  return entities.map((entity, index) => registerEntity(entity, index));
}

export function fpsEntityDefinition(type: number): Readonly<FpsEntityDefinition> | undefined {
  return FPS_ENTITY_DEFINITIONS[type];
}

function registerEntity(entity: MapEntity, index: number): RegisteredMapEntity {
  const definition = fpsEntityDefinition(entity.type);
  const namedAttributes: Record<string, number> = {};
  const names = definition?.attributes ?? ["attr1", "attr2", "attr3", "attr4", "attr5"];
  entity.attributes.forEach((value, attributeIndex) => { namedAttributes[names[attributeIndex] ?? `attr${attributeIndex + 1}`] = value; });
  const yaw = definition?.yawAttribute === undefined ? undefined : entity.attributes[definition.yawAttribute];
  const direction = definition?.direction?.(entity.attributes);
  return {
    ...entity,
    position: { ...entity.position },
    attributes: [...entity.attributes],
    index,
    typeName: definition?.name ?? `unknown-${entity.type}`,
    category: definition?.category ?? "unknown",
    namedAttributes,
    orientation: yaw === undefined && !direction ? undefined : { yawDegrees: yaw, direction },
    mapModelIndex: definition?.mapModelAttribute === undefined ? undefined : entity.attributes[definition.mapModelAttribute],
  };
}

function jumpPadDirection(attributes: MapEntity["attributes"]): Vec3 {
  const vector = { x: signedByte(attributes[2]) * 10, y: signedByte(attributes[1]) * 10, z: attributes[0] * 12.5 };
  const length = magnitude(vector) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function signedByte(value: number): number { return value << 24 >> 24; }
