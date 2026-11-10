# Sauerbraten weapon port

The authoritative reference for this implementation is the checked-out Sauerbraten revision
`00f35db8ffe1281e332edb83262332f8197f671a`. The source tree is read-only and was not modified.

## Native sources

- `src/fpsgame/game.h`: gun IDs, `guninfo`, ammo limits, spawn state, armour absorption, explosion constants, and hit push.
- `src/fpsgame/weapon.cpp`: selection, held-fire timing, spread, ray damage, projectiles, grenade fuse/bounce, splash damage, and kickback.
- `src/engine/physics.cpp`: octree ray semantics and physics timing.

The browser port preserves the player gun IDs 0–6 and reserves IDs 7–11 for the native monster/barrel weapons. `WeaponDefinitions.ts` is the sole gameplay-stat table.

## Architecture

`WeaponSystem` owns the controller, hitscan, projectile, explosion, and damage services. Gameplay emits typed `WeaponEvents`; the renderer, native-asset audio player, and HUD subscribe without changing authoritative combat state. The controller is sampled from the existing update loop and all coordinates remain in Cube 2 space until presentation.

World impacts use `OctreeCollisionWorld.raycast`, including deformed cube planes and map-model collision bounds. Babylon picking is not used for combat. Player kickback and hit push modify the same velocity object used by player physics.

Current local play spawns with the native default FFA state: 100 health, 25 blue armour, 40 pistol rounds, and one grenade. Number keys 1–7 select IDs 0–6, the wheel cycles usable guns, and primary fire works only after pointer lock is already acquired.

## Deliberate boundary

This change establishes deterministic local combat and a damageable interface. The first-person renderer loads the original MD5 hand and weapon bind poses, switches them with the selected gun, and applies a short visual recoil without affecting authoritative combat. Native skeletal animation playback, multiplayer messages, bots, item pickup respawn rules, and production target-dummy placement remain separate integrations.
