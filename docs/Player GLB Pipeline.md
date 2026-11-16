# Player GLB pipeline

All active SauerWeb player bodies (`mrfixit`, `snoutx10k`, `ogro2`, `inky`, and `captaincannon`) are shipped as GLB and rendered with Babylon.js
native skeletons, animation groups, and GPU skinning. The original files under `.Sauerbraten/` remain read-only inputs.

## Regeneration

Blender 5.1 and the installed `sauer_model_tools` add-on are required.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/convert-player-models.ps1
```

The command imports every source MD5/IQM mesh and animation, exports one GLB per unique player rig, and writes source hashes and structural
statistics to `public/assets/models/playermodels/manifest.json`. Team skins remain shared external package textures instead of duplicating geometry
or image payloads into three GLBs per player.

Some original MD5 animations contain data after their declared final frame or an incorrect number of bounds entries. Conversion normalizes a
temporary copy for Blender; it never changes the original package file. The manifest hashes the unmodified source.

## Validation

```powershell
npm run validate:player-glbs
npm test
npm run build
```

The GLB validator loads every file through Babylon's actual glTF loader under `NullEngine`, verifies every source clip, skeleton, mesh skin, normals,
UVs, joint indices and weights, instantiates each model, and stress-instantiates 21 copies of the most animation-heavy model. It also verifies that
the instances share geometry buffers.

This is a structural and non-visual test. Orientation, attachments, team appearance, animation transitions, and in-game visual fidelity still need
the manual browser comparison requested by the project owner.
