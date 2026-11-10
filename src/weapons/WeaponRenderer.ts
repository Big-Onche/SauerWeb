import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { Vec3 } from "../map/types";
import { toBabylonPosition } from "../render/coordinates";
import { Gun } from "./WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "./WeaponEvents";

export class WeaponRenderer {
  private readonly projectiles = new Map<number, Mesh>();

  constructor(private readonly scene: Scene, events: WeaponEvents) {
    events.on((event) => this.handle(event));
  }

  clear(): void {
    this.projectiles.forEach((mesh) => mesh.dispose());
    this.projectiles.clear();
  }

  private handle(event: WeaponEvent): void {
    if (event.type === "shot") {
      const endpoints = event.rays.length ? event.rays : [event.to];
      endpoints.forEach((endpoint) => this.tracer(event.from, endpoint, event.gun));
    } else if (event.type === "projectile-spawned") {
      const mesh = MeshBuilder.CreateSphere(`weapon-projectile-${event.id}`, { diameter: event.gun === Gun.Rocket ? 2.5 : 3 }, this.scene);
      mesh.position.copyFrom(toBabylonPosition(event.position));
      mesh.isPickable = false;
      mesh.material = this.effectMaterial(event.gun === Gun.Grenade ? new Color3(0.2, 0.7, 1) : new Color3(1, 0.35, 0.08));
      this.projectiles.set(event.id, mesh);
    } else if (event.type === "projectile-moved") {
      this.projectiles.get(event.id)?.position.copyFrom(toBabylonPosition(event.position));
    } else if (event.type === "explosion") {
      const existing = [...this.projectiles.entries()].find(([, mesh]) => mesh.position.subtract(toBabylonPosition(event.position)).length() < 5);
      if (existing) {
        existing[1].dispose();
        this.projectiles.delete(existing[0]);
      }
      const sphere = MeshBuilder.CreateSphere("weapon-explosion", { diameter: event.radius * 2, segments: 12 }, this.scene);
      sphere.position.copyFrom(toBabylonPosition(event.position));
      sphere.isPickable = false;
      sphere.material = this.effectMaterial(event.gun === Gun.Grenade ? new Color3(0.25, 0.8, 1) : new Color3(1, 0.25, 0.05));
      window.setTimeout(() => sphere.dispose(), 120);
    }
  }

  private tracer(from: Vec3, to: Vec3, gun: Gun): void {
    if (gun === Gun.Fist || gun === Gun.Rocket || gun === Gun.Grenade) return;
    const line = MeshBuilder.CreateLines("weapon-tracer", { points: [toBabylonPosition(from), toBabylonPosition(to)] }, this.scene);
    line.color = gun === Gun.Rifle ? new Color3(0.8, 0.9, 1) : new Color3(1, 0.75, 0.3);
    line.isPickable = false;
    window.setTimeout(() => line.dispose(), gun === Gun.Rifle ? 90 : 45);
  }

  private effectMaterial(color: Color3): StandardMaterial {
    const material = new StandardMaterial("weapon-effect", this.scene);
    material.diffuseColor = color;
    material.emissiveColor = color;
    material.disableLighting = true;
    material.alpha = 0.72;
    return material;
  }
}
