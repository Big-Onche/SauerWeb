import { describe, expect, it, vi } from "vitest";
import { ClientState } from "../engine/physics/types";
import { PacketReader, PacketWriter } from "../network/protocol";
import type { NetworkPlayer } from "./client";
import { CtfClientMode } from "./ctf";

const CTF_MODE = 11;
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
});

function initialFlagsPacket(): PacketReader {
  const packet = new PacketWriter().putInt(3).putInt(4).putInt(2);
  packet.putInt(12).putInt(-1).putInt(-1).putInt(0).putInt(0);
  packet.putInt(13).putInt(-1).putInt(-1).putInt(0).putInt(0);
  return new PacketReader(packet.finish());
}
