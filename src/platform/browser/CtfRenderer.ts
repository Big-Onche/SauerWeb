import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, type Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { parseMd2 } from "../../engine/rendermodel";
import type { Vec3 } from "../../engine/octa";
import type { CtfFlag } from "../../fpsgame/ctf";
import { ctfTeamFlag } from "../../fpsgame/ctf";
import type { NetworkPlayer } from "../../fpsgame/client";
import { GameModeFlag, gameModeHas } from "../../fpsgame/game";
import { toBabylonPosition } from "../../render/coordinates";

export const FLAG_TRANSPARENCY_MODE = Material.MATERIAL_ALPHATESTANDBLEND;

// Original: src/fpsgame/ctf.h, ctfclientmode::rendergame().
export class CtfRenderer {
  private geometry?: { positions: number[]; uvs: number[]; indices: number[] };
  private readonly meshes = new Map<number, Mesh>();
  private readonly materials = new Map<string, StandardMaterial>();
  private loading?: Promise<void>;

  constructor(private readonly scene: Scene) {}

  render(flags: readonly CtfFlag[], players: ReadonlyMap<number, NetworkPlayer>, localClientNumber: number, localTeam: string,
         localPosition: Vec3, localAboveEye: number, localYaw: number, mode: number,
         playerAttachment: (clientNumber: number) => Vector3 | undefined, now = performance.now()): void {
    if (!gameModeHas(mode, GameModeFlag.Ctf)) { this.setAllEnabled(false); return; }
    if (!this.geometry) { void this.load(); return; }
    const active = new Set<number>();
    for (const flag of flags) {
      if (gameModeHas(mode, GameModeFlag.Hold) && flag.spawnIndex < 0) continue;
      const owner = flag.owner >= 0 ? players.get(flag.owner) : undefined;
      if (flag.owner >= 0 && !owner && flag.owner !== -1) continue;
      const mesh = this.meshes.get(flag.id) ?? this.createMesh(flag.id);
      if (flag.owner === localClientNumber) {
        mesh.position.copyFrom(toBabylonPosition({ ...localPosition, z: localPosition.z + localAboveEye + 5 }));
      } else if (flag.owner >= 0) {
        const attachment = playerAttachment(flag.owner);
        if (!attachment) continue;
        mesh.position.copyFrom(attachment);
      } else mesh.position.copyFrom(toBabylonPosition(flag.dropped ? flag.dropLoc : flag.spawnLoc));
      const yaw = flag.owner === localClientNumber ? localYaw : owner?.yaw ?? flag.yaw;
      mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, 0, 0);
      const displayTeam = gameModeHas(mode, GameModeFlag.Hold) ? owner && now % 1000 >= 500 ? ctfTeamFlag(owner.team) : 0 : flag.team;
      const color = !displayTeam ? "neutral" : displayTeam === ctfTeamFlag(localTeam) ? "blue" : "red";
      mesh.material = this.material(color);
      mesh.visibility = flagVisibility(flag.invisible, flag.invisibleTime, now);
      mesh.setEnabled(true);
      active.add(flag.id);
    }
    for (const [id, mesh] of this.meshes) if (!active.has(id)) mesh.setEnabled(false);
  }

  clear(): void {
    this.meshes.forEach((mesh) => mesh.dispose());
    this.meshes.clear();
    this.materials.forEach((material) => material.dispose(true, true));
    this.materials.clear();
    this.geometry = undefined;
    this.loading = undefined;
  }

  // Original: src/fpsgame/ctf.h
  // Functions: ctfclientmode::preload()
  // Sauerbraten reference: SVN r6488
  async preload(hold: boolean): Promise<void> {
    await this.load();
    if (!this.geometry) throw new Error("Could not initialize CTF flag geometry.");
    if (hold) this.material("neutral");
    else { this.material("red"); this.material("blue"); }
  }

  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const response = await fetch(packageAssetUrl("models/flags/tris.md2")!, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Could not load CTF flag model (${response.status}).`);
      const source = parseMd2(await response.arrayBuffer()).meshes[0];
      const positions = flagModelPositions(source.positions);
      this.geometry = { positions, uvs: source.uvs, indices: source.indices };
    })();
    return this.loading;
  }

  private createMesh(id: number): Mesh {
    const mesh = new Mesh(`ctf-flag-${id}`, this.scene);
    const data = new VertexData();
    data.positions = this.geometry!.positions;
    data.uvs = this.geometry!.uvs;
    data.indices = this.geometry!.indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(data.positions, data.indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh, true);
    mesh.isPickable = false;
    this.meshes.set(id, mesh);
    return mesh;
  }

  private material(color: string): StandardMaterial {
    let material = this.materials.get(color);
    if (material) return material;
    material = new StandardMaterial(`ctf-flag-${color}`, this.scene);
    material.backFaceCulling = false;
    material.specularColor = Color3.White().scale(2);
    material.emissiveColor = Color3.White().scale(0.45);
    const skin = new Texture(packageAssetUrl(`models/flags/${color}/skin.jpg`)!, this.scene, false, false);
    material.diffuseTexture = skin;
    material.emissiveTexture = skin;
    material.emissiveColor = Color3.White();
    material.specularTexture = new Texture(packageAssetUrl("models/flags/masks.jpg")!, this.scene, false, false);
    // Native Protect keeps an unavailable flag visible as a 30%-opaque ghost. Alpha-test-only materials discard partial mesh visibility,
    // so retain the model's cutout test while enabling blending for the per-flag visibility transition.
    material.transparencyMode = FLAG_TRANSPARENCY_MODE;
    material.alphaCutOff = 0.9;
    this.materials.set(color, material);
    return material;
  }

  private setAllEnabled(enabled: boolean): void {
    this.meshes.forEach((mesh) => mesh.setEnabled(enabled));
  }
}

export function flagModelPositions(source: readonly number[], scale = 0.25): number[] {
  return source.map((value) => value * scale);
}

export function flagVisibility(invisible: boolean, transitionTime: number, now: number): number {
  if (invisible) return 0.3;
  return transitionTime > 0 ? 0.3 + 0.7 * Math.min(Math.max((now - transitionTime) / 1000, 0), 1) : 1;
}
