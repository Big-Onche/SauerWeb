import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseIqm, parseMd2, parseMd5 } from "./rendermodel";

describe("MD2 mapmodel loading", () => {
  it.each(["dcp/palmtree", "objects/well_roof", "objects/well_base"])('decodes the bundled model "%s"', (name) => {
    const bytes = fs.readFileSync(path.resolve(`.Sauerbraten/packages/models/${name}/tris.md2`));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const geometry = parseMd2(buffer);

    expect(geometry.meshes).toHaveLength(1);
    expect(geometry.meshes[0].positions.length).toBeGreaterThan(0);
    expect(geometry.meshes[0].uvs.length).toBe(geometry.meshes[0].positions.length / 3 * 2);
    expect(geometry.meshes[0].indices.length).toBeGreaterThan(0);
    expect(geometry.meshes[0].indices.length % 3).toBe(0);
  });
});

describe("IQM mapmodel loading", () => {
  it("decodes the bundled firefly mesh", () => {
    const bytes = fs.readFileSync(path.resolve(".Sauerbraten/packages/models/razgriz/insects/firefly/mesh.iqm"));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const geometry = parseIqm(buffer);

    expect(geometry.meshes.length).toBeGreaterThan(0);
    expect(geometry.meshes.every((mesh) => mesh.positions.length > 0)).toBe(true);
    expect(geometry.meshes.every((mesh) => mesh.indices.length > 0 && mesh.indices.length % 3 === 0)).toBe(true);
  });
});

describe("MD5 model loading", () => {
  it.each(["fist/chainsaw", "shotg/shotgun", "chaing/chaing", "rocket/rl", "rifle/rifle", "gl/gl", "pistol/revolver"])(
    'skins the bundled HUD-gun model "%s" in its bind pose', (name) => {
      const source = fs.readFileSync(path.resolve(`.Sauerbraten/packages/models/hudguns/${name}.md5mesh`), "utf8");
      const geometry = parseMd5(source);

      expect(geometry.meshes.length).toBeGreaterThan(0);
      expect(geometry.meshes.every((mesh) => mesh.positions.length > 0 && mesh.positions.every(Number.isFinite))).toBe(true);
      expect(geometry.meshes.every((mesh) => mesh.uvs.length === mesh.positions.length / 3 * 2)).toBe(true);
      expect(geometry.meshes.every((mesh) => mesh.indices.length > 0 && mesh.indices.length % 3 === 0)).toBe(true);
    },
  );

  it("applies Sauerbraten bone adjustments on top of an idle pose", () => {
    const directory = path.resolve(".Sauerbraten/packages/models/hudguns/pistol");
    const mesh = fs.readFileSync(path.resolve(".Sauerbraten/packages/models/mrfixit/hudguns/fixit_hands.md5mesh"), "utf8");
    const animation = fs.readFileSync(path.join(directory, "hands_revolver_idle.md5anim"), "utf8");
    const unadjusted = parseMd5(mesh, animation);
    const adjusted = parseMd5(mesh, animation, [{ bone: "Root", yaw: 10.5, pitch: -10, roll: 0, translate: [0, 0, 0] }]);

    expect(adjusted.meshes[0].positions).not.toEqual(unadjusted.meshes[0].positions);
  });
});
