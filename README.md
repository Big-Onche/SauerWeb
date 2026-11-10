# SauerWeb

A browser-based viewer for native Cube 2: Sauerbraten maps, built with Babylon.js and TypeScript.

## Run locally

On Windows, double-click `run-server.bat`. It installs dependencies when needed, starts the server, and opens the viewer automatically.

Or run it manually:

```powershell
npm install
npm run dev
```

The Vite development server indexes maps directly from `.Sauerbraten/packages/base`; the reference tree is never modified. Open the printed local URL, filter the archive, and select any enabled v33 map. You can also open a v33 `.ogz` from disk.

Controls: **WASD / arrows** move, the **mouse** looks around, and the diamond button toggles wireframe.

## Current milestone

- Discovers all 331 bundled maps and reports their real format versions.
- Decompresses and validates native `.ogz` files in the browser.
- Decodes v33 headers, variables, game metadata, entities, texture MRU, VSlots, octree nodes, deformed edges, materials, merged-face flags, and serialized surfaces.
- Retains the recursive octree and generates spatially separated Babylon meshes for its eight root octants.
- Extracts water, lava, glass, clip, no-clip, game-clip, death, and alpha leaves into physics-facing material-volume records. Water, lava, and glass use dedicated renderers; the remaining flags are available through the material debug view.
- Decodes all native FPS entity IDs into a Babylon-independent registry with named attributes, positions, orientations, and mapmodel references. Optional debug markers expose the registry in the viewport.
- Starts the camera at the first player-start entity and centralizes Sauerbraten Z-up → Babylon Y-up conversion.
- Reads a restricted declarative subset of default, package, and map `.cfg` files; resolves original image materials, VSlot UV transforms, and six-face map skyboxes from the Sauerbraten package tree.
- Decodes the original 512×512 RGB/RGBA lightmap atlases, preserves reserved and serialized lightmap indexing, and binds the baked UV2 lighting and layer masks through Babylon materials.
- Native MD2, MD3, MD5, IQM, and OBJ models are rendered with Sauerbraten configuration transforms, skins, alpha testing, and culling. First-person MD5 HUD guns use the original weapon and Mr. Fixit hand assets. Older map versions remain unsupported.

See [docs/MAP_FORMAT.md](docs/MAP_FORMAT.md) for the source mapping and format notes.

## Verify

```powershell
npm test
npm run build
```
