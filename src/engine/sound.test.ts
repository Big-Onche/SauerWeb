import { describe, expect, it } from "vitest";
import type { RegisteredMapEntity } from "./octa";
import { SoundSystem, type SoundBackend, type SoundSource } from "./sound";

class TestSource implements SoundSource {
  playing = true;
  volume = -1;
  pan = -1;

  update(volume: number, pan: number): void { this.volume = volume; this.pan = pan; }
  stop(): void { this.playing = false; }
}

class TestBackend implements SoundBackend {
  readonly played: Array<{ path: string; loops: number; source: TestSource }> = [];

  play(path: string, loops: number): SoundSource {
    const source = new TestSource();
    this.played.push({ path, loops, source });
    return source;
  }
}

describe("SoundSystem", () => {
  it("matches Sauerbraten distance attenuation and yaw-relative stereo panning", () => {
    const backend = new TestBackend(), sound = new SoundSystem(backend);
    sound.registersound(0, "sounds/test.wav", 255);
    sound.setListener({ x: 0, y: 0, z: 0 }, 0);
    expect(sound.playsound(0, { loc: { x: 50, y: 0, z: 0 }, radius: 100 })).toBe(0);
    expect(backend.played[0].source.volume).toBeCloseTo(0.5);
    expect(backend.played[0].source.pan).toBeCloseTo(-1);
    sound.setListener({ x: 0, y: 0, z: 0 }, 180);
    sound.updatesounds();
    expect(backend.played[0].source.pan).toBeCloseTo(1);
  });

  it("culls positional sounds beyond one and a half times their effective radius", () => {
    const backend = new TestBackend(), sound = new SoundSystem(backend);
    sound.registersound(0, "sounds/test.wav", 255);
    expect(sound.playsound(0, { loc: { x: 151, y: 0, z: 0 }, radius: 100 })).toBe(-1);
    expect(backend.played).toHaveLength(0);
  });

  it("starts and stops looping map sounds as the listener crosses the entity radius", () => {
    const backend = new TestBackend(), sound = new SoundSystem(backend);
    const entity: RegisteredMapEntity = { index: 0, type: 6, typeName: "sound", category: "sound", position: { x: 10, y: 0, z: 0 },
      attributes: [0, 20, 5, 200, 0], namedAttributes: {} };
    sound.setMap([entity], [{ path: "sounds/ambience/wind.ogg", volume: 100, maxUses: 1 }]);
    sound.setListener({ x: 0, y: 0, z: 0 }, 0);
    sound.updatesounds();
    expect(backend.played[0]).toMatchObject({ path: "sounds/ambience/wind.ogg", loops: -1 });
    expect(backend.played[0].source.volume).toBeCloseTo(2 / 3 * 200 / 255);
    sound.setListener({ x: 40, y: 0, z: 0 }, 0);
    sound.updatesounds();
    expect(backend.played[0].source.playing).toBe(false);
  });
});
