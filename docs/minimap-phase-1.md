# Minimap HUD — Phase 1

The Phase 1 HUD follows the native Sauerbraten paths in `src/fpsgame/client.cpp`, `capture.h`, `ctf.h`, and `collect.h`:

- The radar is 450 units in Sauerbraten's 1800-unit-high HUD space, offset 45 units from the top and right. The native 4% radar-frame margin is preserved.
- `calcradarscale`, edge clamping, camera-yaw rotation, blip sizes, flag image offsets, teammate-arrow rotation, colors, and blink periods use the original values.
- CTF, Protect, Hold, Capture, and Collect use their original visibility tests and objective state. Teammates are limited to alive/dead players on the viewed player's team.
- The native `radar.png` and `blip_*.png` assets are reused. `radar.png` supplies the centered player marker and view cone.

## Intentional Phase 1 differences

- The rendered top-down map texture is deliberately replaced by a neutral translucent circle. Phase 2 will provide the generated map texture.
- Native `minimapclip` obtains its bounds directly from octree cubes. SauerWeb derives the same square XY radius from emitted world geometry because the renderer already has those batches available; an empty map falls back to half the map world size.
- Canvas 2D composites the HUD after Babylon.js renders the world. This replaces Sauerbraten's immediate-mode OpenGL HUD while retaining its logical 1800-unit coordinate system and avoids per-frame DOM nodes or Babylon meshes.
- User console variables for disabling teammate blips and enabling numbered Capture bases do not yet have SauerWeb settings. Their native defaults are used: teammate blips enabled and Capture base icons unnumbered.
- Respawn countdown text is already handled by SauerWeb's existing death UI and is not duplicated inside this minimap canvas.
- On mobile controls, the circular overlay is omitted and the same yaw-relative blips are distributed around the crosshair. The crosshair replaces
  the native radar's centered player marker and view cone, while desktop retains the original upper-right layout.
