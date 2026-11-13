import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, type Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { ClientState } from "../../engine/physics/types";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { parseMd3, parseObj, type ModelGeometry } from "../../engine/rendermodel";
import type { NetworkPlayer } from "../../fpsgame/client";
import { type CollectBase, type CollectToken, collectTeamBase } from "../../fpsgame/collect";
import { GameModeFlag, gameModeHas } from "../../fpsgame/game";
import { toBabylonPosition } from "../../render/coordinates";

// Original: src/fpsgame/collect.h, collectclientmode::rendergame().
export class CollectRenderer {
  private baseGeometry?: Geometry;
  private skullGeometry?: Geometry;
  private readonly meshes = new Map<string, Mesh>();
  private readonly materials = new Map<string, StandardMaterial>();
  private loading?: Promise<void>;

  constructor(private readonly scene: Scene) {}

  render(bases: readonly CollectBase[], tokens: readonly CollectToken[], players: ReadonlyMap<number, NetworkPlayer>, localClientNumber: number,
         localTeam: string, mode: number, now: number, playerAttachment: (clientNumber: number) => Vector3 | undefined): void {
    if (!gameModeHas(mode, GameModeFlag.Collect)) { this.setAllEnabled(false); return; }
    if (!this.baseGeometry || !this.skullGeometry) { void this.load(); return; }
    const active = new Set<string>(), localTeamNumber = collectTeamBase(localTeam);
    for (const base of bases) {
      const color = base.team === localTeamNumber ? "blue" : "red";
      this.place(`base:${base.id}`, this.baseGeometry, base.o, color, 0, active);
      const bob = Math.sin(now / 100) / 20;
      const tokenPosition = { ...base.o, z: base.o.z + this.baseGeometry.height + 3 - bob };
      this.place(`base-skull:${base.id}`, this.skullGeometry, tokenPosition, color, now / 10, active);
    }
    for (const token of tokens) {
      const color = token.team === localTeamNumber || token.team < 0 && -token.team !== localTeamNumber ? "blue" : "red";
      this.place(`token:${token.id}`, this.skullGeometry, { ...token.o, z: token.o.z + 1 + Math.sin(now / 100 + token.o.x + token.o.y) / 20 },
        color, now / 10, active);
    }
    for (const player of players.values()) {
      if (player.clientNumber === localClientNumber || player.tokens <= 0 || player.state !== ClientState.Alive) continue;
      const attachment = playerAttachment(player.clientNumber);
      if (!attachment) continue;
      const color = collectTeamBase(player.team) !== localTeamNumber ? "blue" : "red";
      for (let index = 0; index < player.tokens; index++) {
        const key = `carry:${player.clientNumber}:${index}`, mesh = this.mesh(key, this.skullGeometry, color);
        mesh.position.copyFrom(attachment);
        mesh.position.y += index * 6;
        mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-(player.yaw + 90) * Math.PI / 180, 0, 0);
        mesh.setEnabled(true);
        active.add(key);
      }
    }
    for (const [key, mesh] of this.meshes) if (!active.has(key)) mesh.setEnabled(false);
  }

  clear(): void {
    this.meshes.forEach((mesh) => mesh.dispose());
    this.meshes.clear();
    this.materials.forEach((material) => material.dispose(true, true));
    this.materials.clear();
    this.baseGeometry = this.skullGeometry = undefined;
    this.loading = undefined;
  }

  private place(key: string, geometry: Geometry, position: CollectBase["o"], color: string, yaw: number, active: Set<string>): void {
    const mesh = this.mesh(key, geometry, color);
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, 0, 0);
    mesh.setEnabled(true);
    active.add(key);
  }

  private mesh(key: string, geometry: Geometry, color: string): Mesh {
    let mesh = this.meshes.get(key);
    if (mesh) {
      mesh.material = this.material(key.startsWith("base:") ? "base" : "skull", color);
      return mesh;
    }
    mesh = new Mesh(`collect-${key.replaceAll(":", "-")}`, this.scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.uvs = geometry.uvs;
    data.indices = geometry.indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(data.positions, data.indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh, true);
    mesh.isPickable = false;
    mesh.material = this.material(key.startsWith("base:") ? "base" : "skull", color);
    this.meshes.set(key, mesh);
    return mesh;
  }

  private material(model: "base" | "skull", color: string): StandardMaterial {
    const key = `${model}:${color}`;
    let material = this.materials.get(key);
    if (material) return material;
    material = new StandardMaterial(`collect-${key}`, this.scene);
    const texture = packageAssetUrl(`models/${model}/${model === "base" ? "skin.jpg" : "skull.png"}`)!;
    material.diffuseTexture = new Texture(texture, this.scene, false, false);
    material.diffuseColor = color === "blue" ? new Color3(0.2, 0.35, 1) : new Color3(1, 0.2, 0.15);
    material.emissiveColor = material.diffuseColor.scale(0.2);
    material.specularColor = Color3.White();
    this.materials.set(key, material);
    return material;
  }

  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [baseResponse, skullResponse] = await Promise.all([
        fetch(packageAssetUrl("models/base/base.md3")!, { cache: "no-cache" }),
        fetch(packageAssetUrl("models/skull/skull.obj")!, { cache: "no-cache" }),
      ]);
      if (!baseResponse.ok || !skullResponse.ok) throw new Error("Could not load native Collect models.");
      this.baseGeometry = flatten(parseMd3(await baseResponse.arrayBuffer()), 0.75);
      this.skullGeometry = flatten(parseObj(await skullResponse.text()), 2.5);
    })().catch((error) => { console.warn(error); });
    return this.loading;
  }

  private setAllEnabled(enabled: boolean): void { this.meshes.forEach((mesh) => mesh.setEnabled(enabled)); }
}

interface Geometry { positions: number[]; uvs: number[]; indices: number[]; height: number }

function flatten(model: ModelGeometry, scale: number): Geometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const source of model.meshes) {
    const offset = positions.length / 3;
    positions.push(...source.positions.map((value) => value * scale));
    uvs.push(...source.uvs);
    indices.push(...source.indices.map((index) => index + offset));
  }
  let height = 0;
  for (let index = 1; index < positions.length; index += 3) height = Math.max(height, positions[index]);
  return { positions, uvs, indices, height };
}
