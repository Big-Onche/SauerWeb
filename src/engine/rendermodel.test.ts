import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSauerbratenDirectory } from "../../sauerbratenDirectory";
import { interpolateModelGeometry, iqmAnimationInfo, md5AnimationInfo, parseIqm, parseIqmParts, parseMd2, parseMd5,
  prepareMd5Animation, prepareMd5Model, skinMd5Model, skinMd5ModelParts } from "./rendermodel";

const modelsDirectory = path.join(loadSauerbratenDirectory("test"), "packages", "models");

describe("MD2 mapmodel loading", () => {
  it.each(["dcp/palmtree", "objects/well_roof", "objects/well_base"])('decodes the bundled model "%s"', (name) => {
    const bytes = fs.readFileSync(path.join(modelsDirectory, name, "tris.md2"));
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
    const bytes = fs.readFileSync(path.join(modelsDirectory, "razgriz", "insects", "firefly", "mesh.iqm"));
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
      const source = fs.readFileSync(path.join(modelsDirectory, "hudguns", `${name}.md5mesh`), "utf8");
      const geometry = parseMd5(source);

      expect(geometry.meshes.length).toBeGreaterThan(0);
      expect(geometry.meshes.every((mesh) => mesh.positions.length > 0 && mesh.positions.every(Number.isFinite))).toBe(true);
      expect(geometry.meshes.every((mesh) => mesh.uvs.length === mesh.positions.length / 3 * 2)).toBe(true);
      expect(geometry.meshes.every((mesh) => mesh.indices.length > 0 && mesh.indices.length % 3 === 0)).toBe(true);
    },
  );

  it("applies Sauerbraten bone adjustments on top of an idle pose", () => {
    const directory = path.join(modelsDirectory, "hudguns", "pistol");
    const mesh = fs.readFileSync(path.join(modelsDirectory, "mrfixit", "hudguns", "fixit_hands.md5mesh"), "utf8");
    const animation = fs.readFileSync(path.join(directory, "hands_revolver_idle.md5anim"), "utf8");
    const unadjusted = parseMd5(mesh, animation);
    const adjusted = parseMd5(mesh, animation, [{ bone: "Root", yaw: 10.5, pitch: -10, roll: 0, translate: [0, 0, 0] }]);

    expect(adjusted.meshes[0].positions).not.toEqual(unadjusted.meshes[0].positions);
  });

  it("skins a player model at successive MD5 animation frames", () => {
    const directory = path.join(modelsDirectory, "mrfixit");
    const mesh = fs.readFileSync(path.join(directory, "mrfixit.md5mesh"), "utf8");
    const animation = fs.readFileSync(path.join(directory, "forward.md5anim"), "utf8");

    expect(md5AnimationInfo(animation).frameCount).toBeGreaterThan(1);
    const firstFrame = parseMd5(mesh, animation, [], 0).meshes[0];
    expect(parseMd5(mesh, animation, [], 1).meshes[0].positions).not.toEqual(firstFrame.positions);
    expect(firstFrame.bones).toHaveLength(firstFrame.positions.length / 3);
  });

  it("reuses prepared MD5 topology across skinned animation frames", () => {
    const directory = path.join(modelsDirectory, "mrfixit");
    const model = prepareMd5Model(fs.readFileSync(path.join(directory, "mrfixit.md5mesh"), "utf8"));
    const animation = prepareMd5Animation(fs.readFileSync(path.join(directory, "forward.md5anim"), "utf8"));
    const first = skinMd5Model(model, animation, 0).meshes[0];
    const second = skinMd5Model(model, animation, 1).meshes[0];

    expect(second.positions).not.toEqual(first.positions);
    expect(second.positions).not.toBe(first.positions);
    expect(second.uvs).toBe(first.uvs);
    expect(second.indices).toBe(first.indices);
    expect(second.bones).toBe(first.bones);
  });

  it("interpolates skinned player geometry between animation frames", () => {
    const directory = path.join(modelsDirectory, "mrfixit");
    const mesh = fs.readFileSync(path.join(directory, "mrfixit.md5mesh"), "utf8");
    const animation = fs.readFileSync(path.join(directory, "forward.md5anim"), "utf8");
    const current = parseMd5(mesh, animation, [], 0);
    const next = parseMd5(mesh, animation, [], 1);
    const interpolated = interpolateModelGeometry(current, next, 0.5);

    expect(interpolated.meshes[0].positions[0]).toBeCloseTo((current.meshes[0].positions[0] + next.meshes[0].positions[0]) / 2);
    expect(interpolated.meshes[0].positions).not.toEqual(current.meshes[0].positions);
    expect(interpolated.meshes[0].positions).not.toEqual(next.meshes[0].positions);
  });

  it("combines Sauerbraten locomotion and attack animation parts", () => {
    const directory = path.join(modelsDirectory, "mrfixit");
    const model = prepareMd5Model(fs.readFileSync(path.join(directory, "mrfixit.md5mesh"), "utf8"));
    const run = prepareMd5Animation(fs.readFileSync(path.join(directory, "forward.md5anim"), "utf8"));
    const attack = prepareMd5Animation(fs.readFileSync(path.join(directory, "shotgun_shoot.md5anim"), "utf8"));
    const combined = skinMd5ModelParts(model, [
      { animation: run, frame: 1, roots: [] },
      { animation: attack, frame: 1, roots: ["Spine1"] },
    ]).meshes[0].positions;

    expect(combined).not.toEqual(skinMd5Model(model, run, 1).meshes[0].positions);
    expect(combined).not.toEqual(skinMd5Model(model, attack, 1).meshes[0].positions);
  });

  it("reuses interpolated player geometry buffers", () => {
    const directory = path.join(modelsDirectory, "mrfixit");
    const mesh = fs.readFileSync(path.join(directory, "mrfixit.md5mesh"), "utf8");
    const animation = fs.readFileSync(path.join(directory, "forward.md5anim"), "utf8");
    const current = parseMd5(mesh, animation, [], 0);
    const next = parseMd5(mesh, animation, [], 1);
    const reusable = interpolateModelGeometry(current, next, 0.25);
    const positions = reusable.meshes[0].positions;
    const joints = reusable.joints;

    expect(interpolateModelGeometry(current, next, 0.75, reusable)).toBe(reusable);
    expect(reusable.meshes[0].positions).toBe(positions);
    expect(reusable.joints).toBe(joints);
    expect(reusable.meshes[0].positions[0]).toBeCloseTo(current.meshes[0].positions[0] +
      (next.meshes[0].positions[0] - current.meshes[0].positions[0]) * 0.75);
  });

  it("skins the Ogro player model at successive IQM animation frames", () => {
    const directory = path.join(modelsDirectory, "ogro2");
    const meshBytes = fs.readFileSync(path.join(directory, "ogro.iqm"));
    const animationBytes = fs.readFileSync(path.join(directory, "run.iqm"));
    const mesh = meshBytes.buffer.slice(meshBytes.byteOffset, meshBytes.byteOffset + meshBytes.byteLength) as ArrayBuffer;
    const animation = animationBytes.buffer.slice(animationBytes.byteOffset, animationBytes.byteOffset + animationBytes.byteLength) as ArrayBuffer;

    expect(iqmAnimationInfo(animation).frameCount).toBeGreaterThan(1);
    const firstFrame = parseIqm(mesh, animation, 0).meshes[0];
    expect(parseIqm(mesh, animation, 1).meshes[0].positions).not.toEqual(firstFrame.positions);
    expect(firstFrame.bones).toHaveLength(firstFrame.positions.length / 3);
  });

  it("combines Ogro's IQM locomotion and upper-body attack parts", () => {
    const directory = path.join(modelsDirectory, "ogro2");
    const buffer = (name: string) => {
      const bytes = fs.readFileSync(path.join(directory, name));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    const mesh = buffer("ogro.iqm");
    const run = buffer("run.iqm");
    const attack = buffer("shotgun_shoot.iqm");
    const combined = parseIqmParts(mesh, [
      { buffer: run, frame: 1, roots: [] },
      { buffer: attack, frame: 1, roots: ["Waist"] },
    ]).meshes[0].positions;

    expect(combined).not.toEqual(parseIqm(mesh, run, 1).meshes[0].positions);
    expect(combined).not.toEqual(parseIqm(mesh, attack, 1).meshes[0].positions);
  });
});
