# Sauerbraten physics port

This document is the traceability index for the browser physics implementation. `.Sauerbraten/` is read-only and is the authoritative behavior.
The inspected native revision is `77dab9772147fc8e6861578e0f767204d9daca5a`.

## Milestone 00 sources

| Browser implementation | Native source | Behavior |
| --- | --- | --- |
| `src/engine/physics/types.ts` | `src/shared/ents.h:60-118` | `CS_*`, `PHYS_*`, `COLLIDE_*`, `physent` fields, defaults, and reset state |
| `src/engine/physics/constants.ts` | `src/engine/physics.cpp:473-478,1583` | stair/floor/slope/wall thresholds, jump velocity, gravity, and 5 ms frame time |
| `src/engine/physics/scheduler.ts` | `src/engine/physics.cpp:1748-1775` | ceil-to-frame scheduling and render interpolation |
| `src/engine/physics.ts` | `src/engine/physics.cpp:1549-1571,1590-1675,1682-1723` | input direction, initial velocity/friction/gravity integration, and movement frame structure |
| `src/render/MapScene.ts` | `src/engine/world.cpp:1187-1205`, `src/engine/physics.cpp:2023-2055` | player-start yaw and conversion from feet position to the eye-origin position |
| `src/engine/physics/input.ts` | `src/engine/physics.cpp:2015-2020` | movement and jump input state/sign conventions |
| `src/engine/physics/replay.ts` | deterministic browser-side harness | timestamped input traces with renderer-independent result snapshots |

The milestone-00 integrator deliberately has no collision response. Its role is to validate scheduling, state, input, coordinate conversion, and replay determinism before collision changes trajectories. The octree remains the physics-facing decoded `SauerMap.world`; renderer meshes are not an input to the physics core.

## Collision investigation notes

The next implementation stage must preserve the native split between traversal and cube tests:

- `src/engine/physics.cpp:468-1069`: global collision result state, ellipse/box tests, mapmodel and dynamic-entity collision, solid/deformed cube tests, octree traversal, and `collide`.
- `src/engine/octa.cpp:1204-1302`: `genclipplanes` and cached convex clip geometry for deformed cubes.
- `src/engine/physics.cpp:1072-1400`: projection, floor switching, stair stepping, floor search, landing/falling transitions, and sliding.
- `src/engine/bih.cpp` and `src/engine/mpr.h`: mapmodel BIH and convex MPR collision paths. These are separate from world-octree collision and should remain optional query participants.
- `src/engine/world.h` and `src/engine/octa.h`: cube/extension/clip-plane storage and edge encoding.

## Milestone 03 sources

| Browser implementation | Native source | Behavior |
| --- | --- | --- |
| `src/engine/physics/collision.ts` | `src/engine/physics.cpp:776-1057`, `src/engine/octa.cpp:1204-1251`, `src/engine/mpr.h:113-175` | octree broad phase, solid/deformed cube planes, capsule support points, clip materials, and contact normals |
| `src/engine/physics/ground.ts` | `src/engine/physics.cpp:1072-1400` | floor classification, projection, landing/falling, stairs, ground adhesion, sliding, and collision retries |
| `src/engine/physics.ts` | `src/engine/physics.cpp:1590-1723`, `src/fpsgame/fps.cpp:264-270` | slope-relative desired velocity, gravity, jumping, ten movement substeps, and five-retry collision behavior |

Map-parser integration tests run the controller on the real `aard3c` and `triforts` octrees to ensure their player starts settle on geometry rather than falling through the world.

The contact smoothing path follows `vec::projectxy` (`src/shared/geom.h:147-160`) and `recalcdir`/`switchfloor` (`physics.cpp:1060-1101`). This preserves tangential speed and rescales the remaining substep after projection. Stair transitions use the native synthetic diagonal directions from `trystepup` and `trystepdown` rather than snapping directly between floor elevations.

## Milestone 04 sources

| Browser implementation | Native source | Behavior |
| --- | --- | --- |
| `src/engine/physics.ts` | `src/engine/physics.cpp:1590-1744` | lower-body volume probe, water/lava velocity rules, entry damping, liquid friction, and death/out-of-world state |
| `src/engine/physics/collision.ts` | `src/engine/physics.cpp:535-571,710-773,994-1057` | clip filtering by entity type, mapmodel ellipse/box collision, contact normals, and material lookup |
| `src/render/MapModelLoader.ts` | `src/engine/model.h:44-73`, `src/engine/rendermodel.cpp:52-66,217-232` | model bounds, `mdlcollide`, `mdlellipsecollide`, `mdlbb`, and bounding-box extension definitions |
| `src/render/MapModelLoader.ts` | `src/fpsgame/entities.cpp:396-483` | initial trigger-driven `EF_NOCOLLIDE` filtering |

Mapmodels contribute physics definitions derived from their native model configuration and decoded model bounds; Babylon mesh bounds and picking are not queried by physics.

## Compatibility invariants

- All authoritative positions and velocities use Sauerbraten coordinates (Z-up). Conversion to Babylon Y-up occurs only in `src/render/coordinates.ts`.
- The authoritative entity position is the eye origin; map `PLAYERSTART` entities specify the feet position.
- Rendering reads an interpolated copy and never writes it back into physics state.
- Babylon cameras and meshes are presentation only. They are not collision query inputs.
- Fixed steps use integer milliseconds and the native 5 ms maximum frame time.
