# SauerWeb

A browser-based Cube 2: Sauerbraten client built with Babylon.js and TypeScript. It loads native maps and connects to original
Sauerbraten protocol-260 servers through the bundled ENet WebAssembly transport.

## Run locally

On Windows, double-click `run-server.bat`. It installs dependencies when needed, starts the server, and opens the viewer automatically.

Or run it manually:

```powershell
npm install
npm run dev
```

The Vite development server indexes maps directly from `.Sauerbraten/packages/base`; the reference tree is never modified. Open the printed local URL,
filter the archive, and select any enabled v33 map. You can also open a v33 `.ogz` from disk. The development server also starts the WebSocket-to-UDP
relay and server browser API.

Controls: **WASD / arrows** move, the **mouse** aims, **left click** fires, **T** chats, **Y** team-chats, **G** drops a carried flag, **Tab** opens the
multiplayer scoreboard, **F11** toggles the full console, and the diamond button toggles wireframe. Page Up/Down or keypad +/- scrolls the full console.

## Multiplayer and relay

The multiplayer implementation is pinned to Sauerbraten SVN r6488 (`c63c9f327e278c6b49b39a8163a2717206d4f46a` in the official Git mirror):
protocol 260, map format 33, and ENet 1.3.17. The original ENet C implementation is compiled to WebAssembly; TypeScript only supplies complete UDP datagrams
to it and forwards its output as binary WebSocket frames. The relay never parses or modifies ENet traffic and creates a separate UDP socket for every
browser connection.

The relay retrieves the public server list from Sauerbraten's master server and adds those destinations to the server browser and relay allowlist.
`SAUER_RELAY_SERVERS` adds kept servers (for example a local or unlisted server) alongside the master list:

```powershell
$env:SAUER_RELAY_SERVERS = "127.0.0.1:28785=Local server,play.example.net:28785=Public server"
npm run dev
```

For production, run `npm run build` and `npm run relay`. The standalone process serves `/api/servers`, `/health`, and `/relay`; its port defaults to 8080
and can be changed with `SAUER_RELAY_PORT`. Put it behind the same HTTPS reverse proxy as the static site, or configure native TLS with
`SAUER_RELAY_TLS_KEY` and `SAUER_RELAY_TLS_CERT`. `SAUER_RELAY_ORIGINS` accepts a comma-separated browser-origin allowlist. Connection, message-size,
packet-rate, and byte-rate limits are enforced in the relay. The master defaults to `master.sauerbraten.org:28787`; override it with
`SAUER_MASTER_SERVER`, `SAUER_MASTER_PORT`, or `SAUER_MASTER_TIMEOUT` (milliseconds).

Precompiled ENet JavaScript and WebAssembly artifacts are committed, so Emscripten is not needed for ordinary development or deployment. To reproduce
them with an activated emsdk:

```powershell
npm run build:enet
```

## Source layout

The TypeScript core follows the native Sauerbraten tree. Engine code is renderer-independent and keeps Sauerbraten's Z-up coordinates; Babylon conversion and browser APIs stay at the boundary.

```text
src/
├── engine/
│   ├── serverbrowser.ts
│   ├── physics.ts
│   ├── sound.ts
│   ├── renderva.ts
│   ├── worldio.ts
│   ├── octa.ts
│   └── rendermodel.ts
├── fpsgame/
│   ├── client.ts
│   ├── game.ts
│   ├── weapon.ts
│   └── entities.ts
├── network/
│   ├── enet.ts
│   ├── protocol.ts
│   └── enet/
├── platform/browser/
└── render/
```

Large systems retain focused implementation modules beneath their native entry point, such as `engine/physics/` and `fpsgame/weapon/`. Correspondence comments identify the original C++ file, function, and verified reference revision.

## Current milestone

- Connects to unmodified protocol-260 Sauerbraten servers with native ENet channels, reliability, sequencing, retransmission, and disconnect behavior.
- Implements the native client handshake, map changes, spawn/death lifecycle, position updates, rifle shots, hit reports, damage, score state, pings, and
  instagib HUD/scoreboard flow.
- Provides an HTML/CSS server browser backed by the original master-server list and native server-info queries. Only discovered or explicitly configured
  relay destinations are exposed and connectable.

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
