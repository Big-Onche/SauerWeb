export enum Gun {
  Fist = 0,
  Shotgun = 1,
  Chaingun = 2,
  Rocket = 3,
  Rifle = 4,
  Grenade = 5,
  Pistol = 6,
  Fireball = 7,
  Iceball = 8,
  Slimeball = 9,
  Bite = 10,
  Barrel = 11,
}

export const PLAYER_GUN_COUNT = 7;
export const GUN_COUNT = 12;
export const MAX_RAYS = 20;
export const EXPLOSION_SELF_DAMAGE_DIVISOR = 2;
export const EXPLOSION_SELF_PUSH = 2.5;
export const EXPLOSION_DISTANCE_SCALE = 1.5;
export const SAUERBRATEN_SOURCE_REVISION = "00f35db8ffe1281e332edb83262332f8197f671a";

export interface WeaponDefinition {
  id: Gun;
  name: string;
  model: string | null;
  sound: string | null;
  attackDelay: number;
  damage: number;
  spread: number;
  projectileSpeed: number;
  kickAmount: number;
  range: number;
  rays: number;
  hitPush: number;
  explosionRadius: number;
  projectileLifetime: number;
}

// Original: src/fpsgame/game.h
// Data: guns[]
// Sauerbraten reference: 00f35db8ffe1281e332edb83262332f8197f671a
export const WEAPONS: readonly WeaponDefinition[] = [
  weapon(Gun.Fist, "fist", "fist", "punch1", 250, 50, 0, 0, 0, 14, 1, 80, 0, 0),
  weapon(Gun.Shotgun, "shotgun", "shotg", "shotgun", 1400, 10, 400, 0, 20, 1024, 20, 80, 0, 0),
  weapon(Gun.Chaingun, "chaingun", "chaing", "chaingun", 100, 30, 100, 0, 7, 1024, 1, 80, 0, 0),
  weapon(Gun.Rocket, "rocketlauncher", "rocket", "rocket-fire", 800, 120, 0, 320, 10, 1024, 1, 160, 40, 0),
  weapon(Gun.Rifle, "rifle", "rifle", "rifle", 1500, 100, 0, 0, 30, 2048, 1, 80, 0, 0),
  weapon(Gun.Grenade, "grenadelauncher", "gl", "grenade-launch", 600, 90, 0, 200, 10, 1024, 1, 250, 45, 1500),
  weapon(Gun.Pistol, "pistol", "pistol", "pistol", 500, 35, 50, 0, 7, 1024, 1, 80, 0, 0),
  weapon(Gun.Fireball, "fireball", null, "grenade-launch", 200, 20, 0, 200, 1, 1024, 1, 80, 40, 0),
  weapon(Gun.Iceball, "iceball", null, "iceball", 200, 40, 0, 120, 1, 1024, 1, 80, 40, 0),
  weapon(Gun.Slimeball, "slimeball", null, "slimeball", 200, 30, 0, 640, 1, 1024, 1, 80, 40, 0),
  weapon(Gun.Bite, "bite", null, "pig", 250, 50, 0, 0, 1, 12, 1, 80, 0, 0),
  weapon(Gun.Barrel, "barrel", null, null, 0, 120, 0, 0, 0, 0, 1, 80, 40, 0),
];

export const AMMO_PICKUPS = [
  { add: 10, max: 30 }, { add: 20, max: 60 }, { add: 5, max: 15 },
  { add: 5, max: 15 }, { add: 10, max: 30 }, { add: 30, max: 120 },
] as const;

function weapon(id: Gun, name: string, model: string | null, sound: string | null, attackDelay: number, damage: number, spread: number,
                projectileSpeed: number, kickAmount: number, range: number, rays: number, hitPush: number, explosionRadius: number,
                projectileLifetime: number): WeaponDefinition {
  return { id, name, model, sound, attackDelay, damage, spread, projectileSpeed, kickAmount, range, rays, hitPush, explosionRadius,
    projectileLifetime };
}
