# SauerWeb

### Cube 2: Sauerbraten. In your browser.

**The classic open-source FPS, brought to the modern web.**

Play Sauerbraten directly in your browser, with native maps, real multiplayer servers, and no game installation required.

Powered by **TypeScript (game code), Babylon.js (renderer), WebAssembly (enet).**

**[▶ TRY SAUERWEB](https://sauerweb.org)** | [Source Code](https://github.com/Big-Onche/sauerweb) | [Report an Issue](https://github.com/Big-Onche/sauerweb/issues)

> **⚠️ Experimental Alpha**
>
> SauerWeb is under active development. Expect bugs, missing features, performance issues, and occasional incompatibilities with certain multiplayer servers. It is not yet a complete replacement for the native Sauerbraten client.

---

## What is SauerWeb?

The legendary open-source FPS where you can shoot your friends and edit maps in real time. Well, the map editing part isn't on the web yet.

SauerWeb aims to faithfully port the original Sauerbraten experience to the browser, from its octree engine and physics to its gameplay and multiplayer networking.

The engine is being ported from it's oldschool C++ to TypeScript, with Babylon.js handling rendering and the original ENet networking library compiled to WebAssembly.

**The goal is simple: if it has a modern browser, it should have a shot at running Sauerbraten.**

## Features

| | |
|---|---|
| 🎮 **Real Sauerbraten gameplay** | Native-inspired movement, physics, weapons, combat, and game modes |
| 🌍 **Original maps** | Native `.ogz` decoding, octree geometry, textures, lightmaps, and map entities |
| 🌐 **Real multiplayer** | Connect to existing Sauerbraten protocol-260 servers through an ENet WebAssembly transport |
| 🖥️ **Browser-native rendering** | Babylon.js renders the actual Sauerbraten world without converting maps into external 3D formats |
| 🔫 **Original assets** | Native mapmodels, player models, animations, weapon assets, materials, and skyboxes, when the license allows it |
| 📡 **Live server browser** | Discover servers from Sauerbraten's original master server |
| 🛠️ **Open source** | Inspect the code, contribute improvements, and help bring Sauerbraten to more devices |

### One game. An unreasonable number of devices.

SauerWeb is designed around standard web technologies, making it potentially playable on much more than traditional computers.

- **Desktop and laptops:** Windows, Linux, macOS, and other systems with compatible browsers.
- **Smartphones and tablets:** Browser support, with touch controls still a work in progress.
- **VR headsets:** Potentially playable through their built-in browsers, without native VR support.
- **Smart TVs and unusual hardware:** If the browser supports the required features and the hardware is powerful enough, it's worth a try.
- **Smart cookers and fridges:** No promises. But somebody has to attempt it.

Actual compatibility depends on WebGL support, browser capabilities, available memory, performance, and input methods.

---

## Play online

**[Launch SauerWeb →](https://sauerweb.org)**

No downloads. No installation. No account required.

Open the website, select a map or multiplayer server, and play.

The public version may not support every feature or server yet. Some servers can also reject connections originating from the multiplayer relay.

## Run locally

Want to experiment with the engine, develop features, or run your own instance?

You'll need Node.js and npm, plus access to the Sauerbraten source/assets tree.

### Windows

Simply double-click:

`run-server.bat`

The script installs dependencies when needed, launches the development server, and opens the viewer automatically.

### Manual setup

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

The development server also starts the WebSocket-to-UDP multiplayer relay and server browser API.

### Configure Sauerbraten assets

By default, SauerWeb expects the reference Sauerbraten tree in:

`.Sauerbraten/`

You can point it to another location using an ignored `.env.local` file in the project root.

**Windows:**

```dotenv
SAUERBRATEN_DIR="D:/Games/Sauerbraten"
```

**Linux:**

```dotenv
SAUERBRATEN_DIR="/srv/sauerbraten"
```

Relative paths such as `../sauerbraten` are supported too.

The selected directory must contain `data`, `packages/base`, and `packages/models`.

You can also override the directory for a single run:

```bash
SAUERBRATEN_DIR=/srv/sauerbraten npm run dev
```

On PowerShell:

```powershell
$env:SAUERBRATEN_DIR = "D:\Games\Sauerbraten"
npm run dev
```

The original asset tree is never modified.

---

## How does it work?

SauerWeb is not a conventional JavaScript FPS built to resemble Sauerbraten.

Its architecture follows the original **Cube 2 engine**, with the goal of preserving native game behavior and data formats.

### Rendering

The original Sauerbraten world uses a recursive octree, rather than conventional pre-exported 3D scenes.

SauerWeb decodes `.ogz` maps directly, reconstructs native octree geometry, and renders the result through Babylon.js.

This includes map surfaces, deformed geometry, lightmaps, materials, water, lava, glass, native models, and original texture configurations.

No intermediate OBJ, GLB, or glTF map conversion is necessary.

### Physics and gameplay

Core systems are being ported from the original C++ implementation to TypeScript, keeping the original architecture, naming conventions, and internal coordinate system wherever practical.

Sauerbraten uses Z-up coordinates. Babylon.js uses Y-up coordinates: SauerWeb keeps native coordinates inside the game and engine logic, handling conversion at the rendering boundary.

This separation makes it easier to compare and validate behavior against the original engine.

### Networking

Browsers cannot open ordinary UDP sockets, so SauerWeb uses a lightweight WebSocket-to-UDP relay.

```text
 Browser
    |
    | Binary WebSocket
    |
 SauerWeb Relay
    |
    | UDP / ENet
    |
 Original Sauerbraten Server
```

The original ENet 1.3.17 C library is compiled into WebAssembly, retaining native reliability, sequencing, acknowledgment, and retransmission behavior.

The relay forwards complete binary datagrams without parsing or modifying ENet game traffic.

Each browser connection receives its own UDP socket.

**Compatibility target:**

- Sauerbraten protocol **260**
- Native map formats **29–33**
- ENet **1.3.17**
- Reference: Sauerbraten SVN **r6488**
- Official Git mirror commit: `c63c9f327e278c6b49b39a8163a2717206d4f46a`

---

## Current development status

**Status: Experimental Alpha**

SauerWeb is playable, but still evolving.

### Implemented foundations

- Native `.ogz` decompression, validation, and map-format decoding.
- Discovery of all 331 bundled maps, including their format versions.
- Native v29 to v33 octree geometry, deformed surfaces, merged faces, and material-volume extraction.
- Original map textures, VSlots, lightmap atlases, UV transforms, skyboxes, and supported configuration directives.
- MD2, MD3, MD5, IQM, and OBJ model loading, with native model configuration support.
- Game entities, mapmodels, player starts, and debugging tools.
- Multiplayer client handshake, synchronization, position updates, shooting, damage, spawning, scoring, and disconnect behavior.
- Original ENet transport compiled to WebAssembly.
- Multiplayer server discovery through the original master server.

### Still in development

- Greater parity with native physics and gameplay behavior.
- Additional game modes and complete feature coverage.
- Rendering and CPU performance improvements.
- Broader multiplayer server compatibility.
- Mobile-friendly touch controls.
- UI and HUD fidelity improvements.
- Browser and device compatibility testing.

Older map formats remain unsupported.

The project moves quickly. This section is a milestone overview, not an exhaustive live feature tracker.

---


## Credits

**Cube 2: Sauerbraten** and its original engine, gameplay, assets, and community are the foundation of this project.

SauerWeb is an independent browser-porting effort built around that work.

Special thanks to the Sauerbraten developers and contributors, and to the open-source projects making this possible, including Babylon.js, ENet, Emscripten, and the TypeScript ecosystem.

SauerWeb is not an official Sauerbraten release.

Original Sauerbraten assets and third-party components remain subject to their respective licenses.

---

### Frag your friends. From literally anywhere.

**[Play SauerWeb](https://sauerweb.org)**

*Desktop, laptop, phone, smart TV... or whatever appliance has a browser.*

*The fridge benchmark is still pending.*
