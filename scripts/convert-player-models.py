#!/usr/bin/env python3
"""Convert Sauerbraten MD5/IQM player rigs to animation-complete GLB files.

Run with Blender (5.1 or newer):
  blender --background --python scripts/convert-player-models.py -- \
    --source .Sauerbraten/packages/models --output public/assets/models/playermodels

The installed ``sauer_model_tools`` add-on performs the MD5/IQM import. This script
only orchestrates it, makes clip naming deterministic, and exports/validates GLB.
Original package files are read-only inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import tempfile
from pathlib import Path

import bpy


PLAYER_MODELS = {
    "mrfixit": {"mesh": "mrfixit.md5mesh", "animations": "mrfixit", "format": "md5"},
    "snoutx10k": {"mesh": "snoutx10k.md5mesh", "animations": "mrfixit", "format": "md5"},
    "ogro2": {"mesh": "ogro.iqm", "animations": "ogro2", "format": "iqm"},
    "inky": {"mesh": "inky.md5mesh", "animations": "inky", "format": "md5"},
    "captaincannon": {"mesh": "captaincannon.md5mesh", "animations": "captaincannon", "format": "md5"},
}


def arguments() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", nargs="*", choices=sorted(PLAYER_MODELS), default=sorted(PLAYER_MODELS))
    return parser.parse_args(raw)


def reset_scene() -> None:
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.actions, bpy.data.armatures, bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(collection):
            collection.remove(item)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def animation_info(path: Path) -> dict[str, int | str]:
    header = path.read_text(encoding="utf-8", errors="strict")[:4096]
    frames = re.search(r"\bnumFrames\s+(\d+)", header)
    fps = re.search(r"\bframeRate\s+(\d+)", header)
    joints = re.search(r"\bnumJoints\s+(\d+)", header)
    if not frames or not fps or not joints:
        raise RuntimeError(f"Invalid MD5 animation header: {path}")
    return {
        "name": path.stem,
        "source": path.name,
        "frames": int(frames.group(1)),
        "fps": int(fps.group(1)),
        "joints": int(joints.group(1)),
        "sha256": file_hash(path),
    }


def sanitized_animation(path: Path, frame_count: int, temporary_directory: Path) -> Path:
    """Strip known exporter garbage after the final MD5 frame without touching the source."""
    source = path.read_text(encoding="utf-8-sig", errors="strict")
    final_frame = re.search(rf"(?m)^\s*frame\s+{frame_count - 1}\s*\{{", source)
    if not final_frame:
        raise RuntimeError(f"MD5 animation does not contain frame {frame_count - 1}: {path}")
    closing_brace = source.find("}", final_frame.end())
    if closing_brace < 0:
        raise RuntimeError(f"MD5 animation final frame is not closed: {path}")
    source = source[: closing_brace + 1] + "\n"
    bounds = re.search(r"\bbounds\s*\{([\s\S]*?)\}", source)
    if not bounds:
        raise RuntimeError(f"MD5 animation has no bounds block: {path}")
    bound_lines = re.findall(r"(?m)^\s*(\([^)]*\)\s*\([^)]*\))\s*$", bounds.group(1))
    if len(bound_lines) < frame_count:
        bound_lines.extend(["( 0 0 0 ) ( 0 0 0 )"] * (frame_count - len(bound_lines)))
    normalized_bounds = "bounds {\n\t" + "\n\t".join(bound_lines[:frame_count]) + "\n}"
    source = source[: bounds.start()] + normalized_bounds + source[bounds.end() :]
    sanitized = temporary_directory / path.name
    sanitized.write_text(source, encoding="utf-8")
    return sanitized


def import_model(model: str, source_root: Path) -> tuple[bpy.types.Object, list[dict[str, int | str]]]:
    definition = PLAYER_MODELS[model]
    model_directory = source_root / model
    mesh_path = model_directory / definition["mesh"]
    animation_directory = source_root / definition["animations"]
    if not mesh_path.is_file():
        raise FileNotFoundError(mesh_path)
    if definition["format"] == "iqm":
        return import_iqm_model(model, source_root, mesh_path, animation_directory)
    result = bpy.ops.import_scene.md5mesh(filepath=str(mesh_path))
    if "FINISHED" not in result:
        raise RuntimeError(f"MD5 mesh importer failed for {mesh_path}: {result}")
    rig = bpy.context.object
    if not rig or rig.type != "ARMATURE":
        raise RuntimeError(f"MD5 importer did not select an armature for {mesh_path}")

    clips = []
    with tempfile.TemporaryDirectory(prefix="sauerweb-md5-") as temporary:
        temporary_directory = Path(temporary)
        for animation_path in sorted(animation_directory.glob("*.md5anim")):
            info = animation_info(animation_path)
            clean_path = sanitized_animation(animation_path, int(info["frames"]), temporary_directory)
            print(f"[player-glb] Importing {model}/{animation_path.name}", flush=True)
            result = bpy.ops.import_scene.md5anim(filepath=str(clean_path), start_frame=0)
            if "FINISHED" not in result:
                raise RuntimeError(f"MD5 animation importer failed for {animation_path}: {result}")
            action = rig.animation_data.action
            action.name = str(info["name"])
            action.use_fake_user = True
            action["sauer_source"] = str(info["source"])
            action["sauer_fps"] = int(info["fps"])
            clips.append(info)
    rig.animation_data.action = None
    return rig, clips


def import_iqm_model(model: str, source_root: Path, mesh_path: Path,
                     animation_directory: Path) -> tuple[bpy.types.Object, list[dict[str, int | str]]]:
    del source_root
    result = bpy.ops.import_scene.iqm(filepath=str(mesh_path), load_textures=True)
    if "FINISHED" not in result:
        raise RuntimeError(f"IQM mesh importer failed for {mesh_path}: {result}")
    rig = bpy.context.object
    if not rig or rig.type != "ARMATURE":
        raise RuntimeError(f"IQM importer did not select an armature for {mesh_path}")
    clips = []
    for animation_path in sorted(animation_directory.glob("*.iqm")):
        if animation_path.resolve() == mesh_path.resolve():
            continue
        existing = set(bpy.data.actions)
        print(f"[player-glb] Importing {model}/{animation_path.name}", flush=True)
        result = bpy.ops.import_scene.iqm(filepath=str(animation_path), load_textures=False)
        if "FINISHED" not in result:
            raise RuntimeError(f"IQM animation importer failed for {animation_path}: {result}")
        actions = [action for action in bpy.data.actions if action not in existing]
        if len(actions) != 1:
            raise RuntimeError(f"Expected one animation in {animation_path}, found {len(actions)}")
        action = actions[0]
        action.name = animation_path.stem
        action.use_fake_user = True
        frames = max(1, round(action.frame_range[1] - action.frame_range[0] + 1))
        fps = max(1, round(float(action.get("iqm_fps", 24))))
        clips.append({
            "name": animation_path.stem,
            "source": animation_path.name,
            "frames": frames,
            "fps": fps,
            "joints": len(rig.data.bones),
            "sha256": file_hash(animation_path),
        })
    rig.animation_data.action = None
    return rig, clips


def export_model(model: str, rig: bpy.types.Object, output_root: Path) -> Path:
    directory = output_root / model
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / f"{model}.glb"
    bpy.context.view_layer.objects.active = rig
    for item in bpy.context.selected_objects:
        item.select_set(False)
    rig.select_set(True)
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.find_armature() == rig:
            obj.select_set(True)
    # Babylon converts glTF seconds to its 60 FPS animation timeline. Export at the same rate so each source action frame remains exactly one
    # Babylon frame; Sauerbraten's cfg speed can then advance the original frames without a 24/60 slowdown.
    bpy.context.scene.render.fps = 60
    bpy.context.scene.render.fps_base = 1.0
    result = bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        # SauerWeb applies its existing team-aware StandardMaterials at runtime. Exporting Blender materials would duplicate textures and trigger
        # Babylon's PBR/RGBD environment pipeline before the materials are replaced.
        export_materials="NONE",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_anim_slide_to_zero=True,
        export_skins=True,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True,
        export_optimize_animation_keep_anim_object=False,
        export_apply=False,
        export_extras=True,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"glTF export failed for {model}: {result}")
    return output_path


def validate_glb(path: Path, expected_clips: list[dict[str, int | str]], rig: bpy.types.Object) -> dict[str, int]:
    with path.open("rb") as source:
        magic, version, length = struct.unpack("<4sII", source.read(12))
        if magic != b"glTF" or version != 2 or length != path.stat().st_size:
            raise RuntimeError(f"Malformed GLB header: {path}")
        chunk_length, chunk_type = struct.unpack("<II", source.read(8))
        if chunk_type != 0x4E4F534A:
            raise RuntimeError(f"GLB JSON chunk missing: {path}")
        document = json.loads(source.read(chunk_length).decode("utf-8"))
    animation_names = {animation.get("name") for animation in document.get("animations", [])}
    expected_names = {str(clip["name"]) for clip in expected_clips}
    missing = expected_names - animation_names
    if missing:
        raise RuntimeError(f"GLB is missing animation clips: {', '.join(sorted(missing))}")
    joint_count = len(rig.data.bones)
    skin_joints = max((len(skin.get("joints", [])) for skin in document.get("skins", [])), default=0)
    if skin_joints != joint_count:
        raise RuntimeError(f"GLB skin has {skin_joints} joints; imported rig has {joint_count}")
    if not document.get("meshes") or not document.get("skins"):
        raise RuntimeError(f"GLB does not contain both meshes and skins: {path}")
    return {
        "animations": len(document.get("animations", [])),
        "joints": skin_joints,
        "meshes": len(document.get("meshes", [])),
        "materials": len(document.get("materials", [])),
    }


def main() -> None:
    args = arguments()
    source_root = args.source.resolve()
    output_root = args.output.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {
        "generator": "scripts/convert-player-models.py", "models": {}
    }
    for model in args.models:
        print(f"[player-glb] Converting {model}")
        reset_scene()
        rig, clips = import_model(model, source_root)
        output_path = export_model(model, rig, output_root)
        stats = validate_glb(output_path, clips, rig)
        manifest["models"][model] = {
            "glb": f"{model}/{model}.glb",
            "sourceMesh": str(PLAYER_MODELS[model]["mesh"]),
            "sourceMeshSha256": file_hash(source_root / model / str(PLAYER_MODELS[model]["mesh"])),
            "clips": clips,
            **stats,
            "bytes": output_path.stat().st_size,
        }
        print(f"[player-glb] Wrote {output_path} ({stats['meshes']} meshes, {stats['joints']} joints, {stats['animations']} clips)")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"[player-glb] Wrote {manifest_path}")


if __name__ == "__main__":
    main()
