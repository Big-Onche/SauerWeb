# Sauerbraten map format notes

The implementation is based on the bundled reference at `.Sauerbraten/`; that tree remains untouched. These notes record the C++ → TypeScript mapping used for the first viewer milestone.

## Bundled versions

The 331 maps in `.Sauerbraten/packages/base` use formats 6, 7, 8, 21, 24, 26, 27, 28, 29, 31, 32, and 33. Version 33 accounts for 259 maps and is the version currently accepted by `SauerMapParser`. Older maps stay visible but disabled in the browser so unsupported layouts can never be mistaken for current data.

## Authoritative source mapping

| C++ reference | Relevant behavior | TypeScript equivalent |
| --- | --- | --- |
| `src/engine/world.h` — `octaheader` | 40-byte v33 header and `MAPVERSION` | `SauerMapParser.readHeader` |
| `src/engine/worldio.cpp` — `load_world` | Section order: variables, game data, MRU, entities, VSlots, octree, lightmaps/PVS/blendmap | `SauerMapParser.parse` |
| `src/engine/worldio.cpp` — `loadvslots` / `loadvslot` | Negative blank runs and bit-mask-controlled VSlot fields | `SauerMapParser.readVSlots` |
| `src/engine/worldio.cpp` — `loadchildren` / `loadc` | Eight-child recursion, leaf tags, edges, textures, material, merge and surface payloads | `SauerMapParser.readChildren` / `readCube` |
| `src/engine/octa.h` — `cube`, `surfaceinfo`, `vertinfo` | Typed octree, 12 nibble-packed edges, six textures, surface layers and vertices | `src/map/types.ts` |
| `src/engine/octa.cpp` — `genfaceverts` | Face vertex order reconstructed from edge nibbles | `generatedVertex` / `encodedCorner` |
| `src/engine/octarender.cpp` — `addcubeverts` | Low 12-bit vertex origin restoration and 1/8 world-unit conversion | `geometry.decodeVertex` |
| `src/engine/worldio.cpp` / `lightmap.h` | 512×512 RGB/RGBA atlas records and reserved lightmap IDs | `SauerMapParser.readLightmaps` / `MaterialCache` |
| `src/shared/ents.h` — `entity` | 24-byte entity record | `SauerMapParser.readEntities` |

## Version 33 serialized order

All multi-byte fields are little-endian.

1. `octaheader`: `OCTA`, version, header size, world size, entity/PVS/lightmap counts, blendmap flag, variable count, VSlot count.
2. Map variables: one-byte ident type, 16-bit name length and bytes, then typed payload.
3. Game identifier: one-byte length, bytes plus null terminator, 16-bit entity-extra size, 16-bit game-extra size and bytes.
4. Texture MRU: 16-bit count followed by 16-bit slot IDs.
5. Entities: position as three floats, five signed 16-bit attributes, one-byte type and reserved byte. FPS maps have no extra entity payload.
6. VSlots: signed change masks. Negative masks encode blank runs; changed slots carry a predecessor and mask-selected fields.
7. Eight root octree cubes, recursively serialized.
8. Lightmaps follow the octree. Each record has a type byte, optional unlit coordinates, and a 512×512 RGB or RGBA pixel payload. PVS and blendmap data follow the atlases.

## Octree and geometry

Node tags are `children`, `empty`, `solid`, `normal`, and `lodcube`. A non-branch node stores six texture IDs. Normal and LOD cubes store twelve edge bytes, each containing two four-bit edge endpoints. Version 33 optionally stores a 16-bit material, merge mask, and compact surface block.

The decoded `OctreeCube` hierarchy is retained. Geometry generation visits leaves but never replaces the tree. Output is batched by root octant and VSlot. Until the complete engine `visibleface` behavior is ported, face suppression is deliberately conservative: only a solid neighbor at least as large as the current solid cube can hide a face. This retains some harmless internal faces but cannot turn partial neighbor coverage or deformed cubes into visible holes.

Material-bearing leaves are additionally exposed as `SauerMap.materialVolumes`. Each record retains its raw 16-bit value, bounds, source cube kind, volume/index, clip mode, death flag, and alpha flag independently of ordinary world meshes. Water, lava, and glass are rendered as dedicated volume meshes. Clip, no-clip, game-clip, death, and alpha volumes remain hidden until the material debug toggle is enabled.

FPS entities are decoded into `SauerMap.entityRegistry` while the serialized records remain available in `SauerMap.entities`. The registry covers the engine entity types and all FPS game types through flags, retains all five raw attributes, names type-specific attributes, and exposes yaw or jumppad direction where applicable. Mapmodel indices are matched against the `mapmodelreset`/`mmodel` configuration stream. The asset manifest reports missing models and recognized-but-unsupported MD2, MD3, MD5, IQM, and OBJ formats explicitly; entity debug markers remain available even when the model itself cannot be loaded.

Surface vertices use Sauerbraten's low-12-bit coordinate encoding. The renderer restores the high origin bits and divides by eight, matching `addcubeverts`. Explicit surface polygons are fan-triangulated with reversed winding after the centralized `(x, y, z) → (x, z, y)` conversion.

Merged faces retain Sauerbraten's origin/participant distinction. The origin cube supplies the explicit merged polygon; zero-vertex participant records are coverage markers and never generate fallback cube quads.

## Lightmaps

IDs 0–5 retain Sauerbraten's ambient, directional, bright, and dark reserved meanings. An ID of 6 addresses serialized atlas 0, ID 7 addresses atlas 1, and so on. The renderer preserves that offset instead of treating surface IDs as direct array indices. Atlas pixels remain byte-exact RGB/RGBA data in their original 512×512 dimensions and are uploaded as linear, clamped Babylon raw textures.

Serialized 16-bit lightmap coordinates are normalized by 65536 and shifted by half a 512-pixel lumel, matching `addcubeverts`. They are supplied as Babylon UV2 coordinates. Materials multiply the diffuse result by the baked lightmap and disable Babylon's dynamic-light contribution, so the baked illumination remains authoritative. Layered surfaces use the secondary ID and duplicated UV set for the bottom layer; an RGBA primary atlas supplies the baked blend mask for the top layer.

The restricted configuration reader resolves `skybox`, legacy `loadsky`, `yawsky`, `spinsky`, `skyboxcolour`, `ambient`, and `skylight` declarations without executing CubeScript. Map CFG values override values serialized in the OGZ, which in turn override Sauerbraten's defaults. `ambient` supplies the reserved unlit lightmap. `skylight` remains baked into serialized atlas pixels, matching Sauerbraten rather than applying a second runtime light over them. Cubemap faces use Sauerbraten's `rt/lf/bk/ft/up/dn` package convention, reordered for the renderer's Z-up to Y-up coordinate conversion and visually aligned by 270 degrees around the vertical axis. JPEG, PNG, wildcard names, yaw, spin, and sky color metadata are retained.

## Deliberate next steps

- Port historical layout branches from `loadc` for formats 6–32.
- Replace conservative solid-neighbor face suppression with the complete `visibleface` / merged-face behavior from `octarender.cpp`.
- Execute the safe texture subset of default and map `.cfg` files, resolve Slots/VSlots to package images, and generate texture UVs.
- Decode PVS and blendmap payloads rather than stopping at the octree boundary.
- Add native model loaders and full gameplay rendering for the entity records currently shown as debug markers.
