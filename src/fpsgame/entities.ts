import type { EntityCategory, MapEntity, RegisteredMapEntity, Vec3 } from "../engine/octa";

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
// Sauerbraten reference: 77dab9772147fc8e6861578e0f767204d9daca5a
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
  const signedByte = (value: number) => value << 24 >> 24;
  const vector = { x: signedByte(attributes[2]) * 10, y: signedByte(attributes[1]) * 10, z: attributes[0] * 12.5 };
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
