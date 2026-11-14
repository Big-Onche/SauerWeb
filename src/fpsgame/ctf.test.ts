import { describe, expect, it, vi } from "vitest";
import { ClientState } from "../engine/physics/types";
import { PacketReader, PacketWriter } from "../network/protocol";
import type { NetworkPlayer } from "./client";
import { CtfClientMode } from "./ctf";

const CTF_MODE = 11;
const PROTECT_MODE = 13;
const HOLD_MODE = 15;
const FLAGS = [
  { typeName: "flag", position: { x: 100, y: 200, z: 20 }, attributes: [90, 1] },
  { typeName: "flag", position: { x: 500, y: 600, z: 30 }, attributes: [270, 2] },
];

describe("CTF map lifecycle", () => {
  it("restores base entities when the server selects the map that is already loaded", () => {
    const mode = new CtfClientMode();
    mode.setup(FLAGS, CTF_MODE);
    mode.reset();
    mode.setup(FLAGS, CTF_MODE);
    mode.parseInitFlags(initialFlagsPacket(), CTF_MODE);

    expect(mode.flags).toMatchObject([
      { team: 1, spawnLoc: FLAGS[0].position, yaw: 90, owner: -1, dropped: false, invisible: false },
      { team: 2, spawnLoc: FLAGS[1].position, yaw: 270, owner: -1, dropped: false, invisible: false },
    ]);
  });

  it("requests the enemy base flag using the server version", () => {
    const mode = new CtfClientMode();
    mode.setup(FLAGS, CTF_MODE);
    mode.parseInitFlags(initialFlagsPacket(), CTF_MODE);
    const take = vi.fn();
    const player = { state: ClientState.Alive, team: "good" } as NetworkPlayer;

    mode.checkItems(player, FLAGS[1].position, CTF_MODE, take);

    expect(take).toHaveBeenCalledOnce();
    expect(take).toHaveBeenCalledWith(1, 13);
  });

  it("runs vanilla steal, drop, return and capture transitions for a local match", () => {
    const mode = new CtfClientMode();
    mode.setup(FLAGS, CTF_MODE);
    const good = { clientNumber: 0, state: ClientState.Alive, team: "good", flags: 0 } as NetworkPlayer;
    const evil = { clientNumber: 1, state: ClientState.Alive, team: "evil", flags: 0 } as NetworkPlayer;

    expect(mode.takeFlagLocal(good, 1, 0, CTF_MODE)).toBe(true);
    expect(mode.flags[1].owner).toBe(0);
    expect(mode.dropFlags(0, { x: 20, y: 30, z: 4 }, 90)).toBe(true);
    expect(mode.flags[1]).toMatchObject({ owner: -1, dropped: true, dropLoc: { x: 20, y: 30, z: 4 } });
    expect(mode.takeFlagLocal(evil, 1, mode.flags[1].version, CTF_MODE)).toBe(true);
    expect(mode.flags[1]).toMatchObject({ owner: -1, dropped: false });

    expect(mode.takeFlagLocal(good, 1, mode.flags[1].version, CTF_MODE)).toBe(true);
    expect(mode.takeFlagLocal(good, 0, mode.flags[0].version, CTF_MODE)).toBe(true);
    expect(good.flags).toBe(1);
    expect(mode.scores).toEqual([1, 0]);
    expect(mode.flags[1].owner).toBe(-1);
  });

  it("runs native protect visibility, scoring and dropped-flag penalty timers", () => {
    const mode = new CtfClientMode();
    mode.setup(FLAGS, PROTECT_MODE);
    mode.initializeLocal(PROTECT_MODE, 1_000);
    const good = { clientNumber: 0, state: ClientState.Alive, team: "good", flags: 0 } as NetworkPlayer;
    const players = new Map([[0, good]]);

    expect(mode.flags.every((flag) => flag.invisible)).toBe(true);
    mode.updateLocal(players, PROTECT_MODE, 20_999);
    expect(mode.flags.every((flag) => flag.invisible)).toBe(true);
    mode.updateLocal(players, PROTECT_MODE, 21_000);
    expect(mode.flags.every((flag) => !flag.invisible)).toBe(true);

    expect(mode.takeFlagLocal(good, 1, mode.flags[1].version, PROTECT_MODE, undefined, 22_000)).toBe(true);
    expect(mode.scores).toEqual([1, 0]);
    expect(mode.flags[1].invisible).toBe(true);

    expect(mode.takeFlagLocal(good, 0, mode.flags[0].version, PROTECT_MODE, undefined, 42_000)).toBe(true);
    expect(mode.dropFlags(0, { x: 200, y: 200, z: 20 }, 0, PROTECT_MODE, undefined, 43_000)).toBe(true);
    mode.updateLocal(players, PROTECT_MODE, 53_000);
    expect(mode.scores).toEqual([0, 0]);
    expect(mode.flags[0]).toMatchObject({ owner: -1, dropped: false, invisible: true });
  });

  it("scores hold after 20 seconds and applies the native five-second death penalty", () => {
    const bases = [
      { typeName: "base", position: { x: 10, y: 20, z: 30 }, attributes: [0] },
      { typeName: "base", position: { x: 50, y: 60, z: 70 }, attributes: [0] },
    ];
    const mode = new CtfClientMode();
    mode.setup(bases, HOLD_MODE);
    mode.initializeLocal(HOLD_MODE, 0, () => 0);
    const good = { clientNumber: 0, state: ClientState.Alive, team: "good", flags: 0 } as NetworkPlayer;
    const players = new Map([[0, good]]);

    expect(mode.flags[0]).toMatchObject({ spawnIndex: 0, spawnLoc: bases[0].position, team: 0 });
    expect(mode.takeFlagLocal(good, 0, 0, HOLD_MODE, undefined, 1_000)).toBe(true);
    expect(mode.holdSecondsRemaining(0, 15_000)).toBe(6);
    expect(mode.dropFlags(0, { x: 100, y: 100, z: 30 }, 0, HOLD_MODE, undefined, 16_000, true)).toBe(true);
    expect(mode.takeFlagLocal(good, 0, mode.flags[0].version, HOLD_MODE, undefined, 17_000)).toBe(true);
    expect(mode.holdSecondsRemaining(0, 17_000)).toBe(11);
    mode.updateLocal(players, HOLD_MODE, 27_999, () => 0.99);
    expect(mode.scores).toEqual([0, 0]);
    mode.updateLocal(players, HOLD_MODE, 28_000, () => 0.99);
    expect(mode.scores).toEqual([1, 0]);
    expect(good.flags).toBe(1);
    expect(mode.flags[0]).toMatchObject({ owner: -1, team: 0, spawnIndex: 1, spawnLoc: bases[1].position });
  });
});

function initialFlagsPacket(): PacketReader {
  const packet = new PacketWriter().putInt(3).putInt(4).putInt(2);
  packet.putInt(12).putInt(-1).putInt(-1).putInt(0).putInt(0);
  packet.putInt(13).putInt(-1).putInt(-1).putInt(0).putInt(0);
  return new PacketReader(packet.finish());
}
