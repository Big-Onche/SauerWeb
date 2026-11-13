import { describe, expect, it, vi } from "vitest";
import { ClientState } from "../engine/physics/types";
import { PacketReader, PacketWriter } from "../network/protocol";
import { createClient, type NetworkPlayer } from "./client";
import { CollectClientMode, COLLECT_EXPIRE_TOKEN_TIME, COLLECT_SCORE_LIMIT, COLLECT_STEAL_TOKEN_TIME,
  COLLECT_TOKEN_LIMIT } from "./collect";
import { DMF, NetworkMessage } from "./game";
import { createFpsEntityRegistry } from "./entities";

const BASES = [
  { typeName: "flag", position: { x: 10, y: 20, z: 4 }, attributes: [0, 1] },
  { typeName: "flag", position: { x: 100, y: 200, z: 8 }, attributes: [0, 2] },
];

describe("native Collect protocol and state", () => {
  it("serializes the client-to-server N_INITTOKENS base payload exactly", () => {
    const mode = identityMode();
    mode.setup(BASES);
    const writer = new PacketWriter();
    mode.putInitTokens(writer);
    const packet = new PacketReader(writer.finish());

    expect(packet.getInt()).toBe(2);
    expect([packet.getInt(), packet.getInt(), packet.getInt(), packet.getInt()]).toEqual([1, 10 * DMF, 20 * DMF, 4 * DMF]);
    expect([packet.getInt(), packet.getInt(), packet.getInt(), packet.getInt()]).toEqual([2, 100 * DMF, 200 * DMF, 8 * DMF]);
    expect(packet.remaining).toBe(0);
  });

  it("parses the different server-to-client N_INITTOKENS scores, dropped tokens and inventories", () => {
    const mode = identityMode(), writer = new PacketWriter();
    writer.putInt(12).putInt(17).putInt(2);
    writer.putInt(41).putInt(-1).putInt(90).putInt(16).putInt(32).putInt(48);
    writer.putInt(42).putInt(2).putInt(180).putInt(64).putInt(80).putInt(96);
    writer.putInt(3).putInt(4).putInt(9).putInt(2).putInt(-1);

    const carried = mode.parseInitTokens(new PacketReader(writer.finish()), 500);

    expect(mode.scores).toEqual([12, 17]);
    expect(mode.tokens).toMatchObject([
      { id: 41, team: -1, yaw: 90, o: { x: 1, y: 2, z: 3 }, dropTime: 500 },
      { id: 42, team: 2, yaw: 180, o: { x: 4, y: 5, z: 6 }, dropTime: 500 },
    ]);
    expect(carried).toEqual([{ clientNumber: 3, tokens: 4 }, { clientNumber: 9, tokens: 2 }]);
  });

  it("applies native signed-team pickup eligibility and the five-token cap", () => {
    const mode = identityMode(), player = collectPlayer(1, "good");
    for (const [id, team] of [[1, 1], [2, 2], [3, -1], [4, -2]] as const) mode.dropToken(id, { x: id, y: 0, z: 0 }, team, 0, 0);

    mode.takeTokenLocal(player, 1);
    expect(player.tokens).toBe(0);
    mode.takeTokenLocal(player, 2);
    mode.takeTokenLocal(player, 3);
    expect(player.tokens).toBe(2);
    mode.takeTokenLocal(player, 4);
    expect(player.tokens).toBe(2);
    player.tokens = COLLECT_TOKEN_LIMIT;
    mode.dropToken(5, { x: 5, y: 0, z: 0 }, 2, 0, 0);
    mode.takeTokenLocal(player, 5);
    expect(player.tokens).toBe(COLLECT_TOKEN_LIMIT);
    expect(mode.tokens).toHaveLength(0);
  });

  it("drops one friendly skull plus carried enemy skulls, or only the penalty skull after a teamkill", () => {
    const mode = identityMode(), player = collectPlayer(7, "good");
    player.tokens = 3;
    const normal = mode.dropTokensLocal(player, { x: 8, y: 9, z: 10 }, false, 1000, () => 0.25);
    expect(normal.map((token) => token.team)).toEqual([1, -1, -1, -1]);
    expect(player.tokens).toBe(0);

    player.tokens = 4;
    const penalty = mode.dropTokensLocal(player, { x: 8, y: 9, z: 10 }, true, 2000, () => 0.5);
    expect(penalty.map((token) => token.team)).toEqual([1]);
    expect(player.tokens).toBe(0);
  });

  it("deposits at the enemy base, steals on the native cooldown, expires skulls, and reaches the score limit", () => {
    const mode = identityMode(), good = collectPlayer(1, "good"), events = vi.fn();
    mode.setup(BASES);
    good.tokens = 5;
    mode.setScore(1, COLLECT_SCORE_LIMIT - 5);
    expect(mode.depositTokensLocal(good, 1, 1000, () => 0, events)).toBe(true);
    expect(mode.scores).toEqual([COLLECT_SCORE_LIMIT, 0]);
    expect(good).toMatchObject({ tokens: 0, flags: 5 });

    mode.setScore(2, 2);
    expect(mode.depositTokensLocal(good, 1, 1000 + COLLECT_STEAL_TOKEN_TIME - 1, () => 0, events)).toBe(false);
    expect(mode.depositTokensLocal(good, 1, 1000 + COLLECT_STEAL_TOKEN_TIME, () => 0, events)).toBe(true);
    expect(mode.scores[1]).toBe(1);
    expect(mode.tokens.at(-1)).toMatchObject({ team: 1, dropper: -2 });

    mode.updateLocal(1000 + COLLECT_STEAL_TOKEN_TIME + COLLECT_EXPIRE_TOKEN_TIME, events);
    expect(mode.tokens).toHaveLength(0);
    expect(events.mock.calls.some(([event]) => event.type === "expire")).toBe(true);
  });

  it("sends native server-authoritative pickup and deposit requests without local awards", () => {
    const client = createClient(), multiplayer = client.multiplayer;
    multiplayer.setGameMode(20);
    multiplayer.setMapEntities(createFpsEntityRegistry(BASES.map((base) => ({ type: 30, position: base.position,
      attributes: [base.attributes[0], base.attributes[1], 0, 0, 0] as [number, number, number, number, number] }))));
    multiplayer.connected = true;
    multiplayer.clientNumber = 4;
    const player = Reflect.apply(Reflect.get(multiplayer, "playerFor"), multiplayer, [4]) as NetworkPlayer;
    Object.assign(player, { state: ClientState.Alive, alive: true, team: "good", tokens: 0 });
    client.physics.player.alive = true;
    client.physics.player.clientState = ClientState.Alive;
    client.physics.player.position = { x: 30, y: 40, z: client.physics.player.eyeHeight };
    multiplayer.collectMode.tokens.push({ id: 77, team: 2, o: { x: 30, y: 40, z: 0 }, yaw: 0, dropTime: 0, dropper: -1 });
    const send = vi.spyOn(multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(multiplayer.transport, "flush").mockImplementation(() => undefined);

    multiplayer.update(1000);

    const takeBytes = send.mock.calls.find(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.TakeToken)?.[1];
    expect(takeBytes).toBeDefined();
    const take = new PacketReader(takeBytes ?? new Uint8Array());
    expect([take.getInt(), take.getInt()]).toEqual([NetworkMessage.TakeToken, 77]);
    expect(player.tokens).toBe(0);
    expect(multiplayer.collectMode.findToken(77)).toBeDefined();

    multiplayer.collectMode.tokens.length = 0;
    player.tokens = 2;
    client.physics.player.position = { ...BASES[1].position, z: BASES[1].position.z + client.physics.player.eyeHeight };
    multiplayer.update(1100);
    const depositBytes = send.mock.calls.find(([, bytes]) => {
      const packet = new PacketReader(bytes);
      return packet.getInt() === NetworkMessage.DepositTokens;
    })?.[1];
    const deposit = new PacketReader(depositBytes ?? new Uint8Array());
    expect([deposit.getInt(), deposit.getInt()]).toEqual([NetworkMessage.DepositTokens, 1]);
    expect(player.tokens).toBe(0);
    expect(multiplayer.collectMode.scores).toEqual([0, 0]);
  });

  it("enforces the native five-second Collect respawn delay before N_TRYSPAWN", () => {
    const client = createClient(), multiplayer = client.multiplayer;
    multiplayer.setGameMode(20);
    multiplayer.connected = true;
    multiplayer.clientNumber = 4;
    const player = Reflect.apply(Reflect.get(multiplayer, "playerFor"), multiplayer, [4]) as NetworkPlayer;
    Object.assign(player, { state: ClientState.Dead, alive: false, deadAt: 1000 });
    client.physics.player.alive = false;
    const send = vi.spyOn(multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(multiplayer.transport, "flush").mockImplementation(() => undefined);

    expect(multiplayer.requestRespawn()).toBe(true);
    multiplayer.update(5999);
    expect(send.mock.calls.some(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.TrySpawn)).toBe(false);
    multiplayer.update(6032);
    expect(send.mock.calls.some(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.TrySpawn)).toBe(true);
  });
});

function identityMode(): CollectClientMode { return new CollectClientMode((origin) => ({ ...origin })); }

function collectPlayer(clientNumber: number, team: string): NetworkPlayer {
  return { clientNumber, team, state: ClientState.Alive, tokens: 0, flags: 0 } as NetworkPlayer;
}
