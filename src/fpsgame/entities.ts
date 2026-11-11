import type { EntityCategory, MapEntity, RegisteredMapEntity, Vec3 } from "../engine/octa";
import type { PhysicsSimulation } from "../engine/physics";
import { ClientState, PhysicsState } from "../engine/physics/types";
import { magnitude } from "../engine/physics/vector";

export const TELEPORT = 19;
export const TELEDEST = 20;
export const JUMPPAD = 23;

export type EntityEffect = { type: "teleport"; teleport: number; teledest: number } |
  { type: "jumppad"; jumppad: number };

export interface FpsEntityCallbacks {
  effect?: (effect: EntityEffect, local: boolean) => void;
  send?: (effect: EntityEffect) => void;
  warning?: (message: string) => void;
}

// Original: src/fpsgame/entities.cpp
// Functions: checkitems(), trypickup(), teleport(), teleporteffects(), jumppadeffects()
// Sauerbraten reference: SVN r6488
export class FpsEntities {
  ents: readonly RegisteredMapEntity[] = [];
  private lastpickup = -1;
  private lastpickupmillis = Number.NEGATIVE_INFINITY;

  constructor(private readonly physics: PhysicsSimulation, private readonly callbacks: FpsEntityCallbacks = {}) {}

  setMap(entities: readonly RegisteredMapEntity[]): void {
    this.ents = entities;
    this.lastpickup = -1;
    this.lastpickupmillis = Number.NEGATIVE_INFINITY;
  }

  checkitems(lastmillis: number): void {
    const d = this.physics.player;
    if (!d.alive || d.clientState !== ClientState.Alive) return;
    const o = { ...d.position, z: d.position.z - d.eyeHeight };
    for (const e of this.ents) {
      if (e.type !== TELEPORT && e.type !== JUMPPAD) continue;
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
