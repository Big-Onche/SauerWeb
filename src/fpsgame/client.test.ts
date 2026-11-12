import { describe, expect, it, vi } from "vitest";
import { PacketReader, PacketWriter } from "../network/protocol";
import { createClient, serializeShoot, type NetworkPlayer } from "./client";
import { DMF, DNF, NetworkMessage } from "./game";
import { createDamageable } from "./weapon/DamageSystem";
import { Gun } from "./weapon/WeaponDefinitions";
import type { WeaponEvent } from "./weapon/WeaponEvents";
import { createFpsEntityRegistry } from "./entities";
import { ClientState } from "../engine/physics/types";
import { GameSound } from "./sound";

describe("Sauerbraten rifle protocol", () => {
  it("serializes the exact native N_SHOOT fields and hit record", () => {
    const target = Object.assign(createDamageable("client:7", { x: 0, y: 50, z: 14 }), {
      clientNumber: 7, lifeSequence: 3,
    }) as NetworkPlayer;
    const event: Extract<WeaponEvent, { type: "shot" }> = {
      type: "shot",
      gun: Gun.Rifle,
      millis: 2400,
      from: { x: 1.25, y: -2.5, z: 14 },
      to: { x: 1.25, y: 45.875, z: 14 },
      rays: [{ x: 1.25, y: 45.875, z: 14 }],
      hits: [{ target, distance: 48.375, rays: 1, direction: { x: 0, y: 1, z: 0 } }],
    };

    const packet = new PacketReader(serializeShoot(event, 1234));

    expect(packet.getInt()).toBe(NetworkMessage.Shoot);
    expect(packet.getInt()).toBe(1234);
    expect(packet.getInt()).toBe(Gun.Rifle);
    expect(readVector(packet, DMF)).toEqual(event.from);
    expect(readVector(packet, DMF)).toEqual(event.to);
    expect(packet.getInt()).toBe(1);
    expect(packet.getInt()).toBe(7);
    expect(packet.getInt()).toBe(3);
    expect(packet.getInt()).toBe(Math.trunc(48.375 * DMF));
    expect(packet.getInt()).toBe(1);
    expect(readVector(packet, DNF)).toEqual({ x: 0, y: 1, z: 0 });
    expect(packet.remaining).toBe(0);
  });

  it("queues respawn only while connected and dead", () => {
    const client = createClient();
    expect(client.multiplayer.requestRespawn()).toBe(false);
    client.multiplayer.connected = true;
    expect(client.multiplayer.requestRespawn()).toBe(false);
    client.physics.player.alive = false;
    expect(client.multiplayer.requestRespawn()).toBe(true);
  });

  it("sends N_TRYSPAWN as a reliable standalone message", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    client.physics.player.alive = false;
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);

    client.multiplayer.requestRespawn();
    client.multiplayer.update(0);

    const spawnCall = send.mock.calls.find(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.TrySpawn);
    expect(spawnCall).toBeDefined();
    expect(spawnCall?.[0]).toBe(1);
    expect(spawnCall?.[2]).toBe(true);
    const packet = new PacketReader(spawnCall?.[1] ?? new Uint8Array());
    expect(packet.getInt()).toBe(NetworkMessage.TrySpawn);
    expect(packet.remaining).toBe(0);
  });

  it("requests spectator changes without changing state before server confirmation", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);

    expect(client.multiplayer.setSpectator(true)).toBe(true);
    expect(client.multiplayer.isSpectator).toBe(false);
    const packet = new PacketReader(send.mock.calls[0][1]);
    expect(send.mock.calls[0][0]).toBe(1);
    expect(send.mock.calls[0][2]).toBe(true);
    expect([packet.getInt(), packet.getInt(), packet.getInt()]).toEqual([NetworkMessage.Spectator, 4, 1]);
    expect(packet.remaining).toBe(0);
  });

  it("sends the loaded map CRC reliably before spawning", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    client.multiplayer.mapName = "complex";
    client.multiplayer.setMapInfo("complex", 0xcbf43926);
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);

    client.multiplayer.update(0);

    const mapCall = send.mock.calls.find(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.MapCrc);
    expect(mapCall?.[0]).toBe(1);
    expect(mapCall?.[2]).toBe(true);
    const packet = new PacketReader(mapCall?.[1] ?? new Uint8Array());
    expect(packet.getInt()).toBe(NetworkMessage.MapCrc);
    expect(packet.getString()).toBe("complex");
    expect(packet.getInt()).toBe(0xcbf43926 | 0);
    expect(packet.remaining).toBe(0);
  });

  it.each([
    { team: false, type: NetworkMessage.Text },
    { team: true, type: NetworkMessage.SayTeam },
  ])("sends $type chat using the native reliable packet", ({ team, type }) => {
    const client = createClient();
    client.multiplayer.connected = true;
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);

    client.multiplayer.sendChat("  hello team  ", team);

    expect(send).toHaveBeenCalledTimes(1);
    const packet = new PacketReader(send.mock.calls[0][1]);
    expect(send.mock.calls[0][0]).toBe(1);
    expect(send.mock.calls[0][2]).toBe(true);
    expect(packet.getInt()).toBe(type);
    expect(packet.getString()).toBe("hello team");
    expect(packet.remaining).toBe(0);
  });
});

describe("native server message framing", () => {
  it("uses the normal client lifecycle for a local bot match", () => {
    const client = createClient();
    const events: string[] = [];
    client.multiplayer.addEventListener("multiplayer", (event) => events.push((event as CustomEvent).detail.type));

    client.multiplayer.startLocalGame("local player", 2);
    client.multiplayer.setLocalTeam("good");

    expect(client.multiplayer.clientNumber).toBe(0);
    expect(client.multiplayer.isLocalGame).toBe(true);
    expect(client.multiplayer.scoreboard).toMatchObject([{ clientNumber: 0, name: "local player", model: 2, team: "good" }]);
    expect(client.multiplayer.setSpectator(true)).toBe(true);
    expect(client.multiplayer.isSpectator).toBe(true);
    expect(client.multiplayer.setSpectator(false)).toBe(true);
    expect(client.multiplayer.isSpectator).toBe(false);
    expect(events).toContain("spawn");
  });

  it("emits vanilla CTF console messages for local flag transitions", () => {
    const client = createClient();
    const lines: string[] = [];
    client.multiplayer.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "console") lines.push(detail.text);
    });
    client.multiplayer.gameMode = 11;
    client.multiplayer.startLocalGame("local player");
    client.multiplayer.setLocalTeam("good");
    client.multiplayer.setMapEntities(createFpsEntityRegistry([
      { type: 30, position: { x: 100, y: 200, z: 20 }, attributes: [90, 1, 0, 0, 0] },
      { type: 30, position: { x: 500, y: 600, z: 30 }, attributes: [270, 2, 0, 0, 0] },
    ]));

    client.physics.player.position = { x: 500, y: 600, z: 30 + client.physics.player.eyeHeight };
    client.multiplayer.update(1000);
    client.multiplayer.tryDropFlag();
    client.multiplayer.switchTeam();
    client.multiplayer.update(1100);
    client.multiplayer.switchTeam();
    client.physics.player.position = { x: 100, y: 200, z: 20 + client.physics.player.eyeHeight };
    client.multiplayer.update(1200);
    client.physics.player.position = { x: 500, y: 600, z: 30 + client.physics.player.eyeHeight };
    client.multiplayer.update(1300);
    client.physics.player.position = { x: 100, y: 200, z: 20 + client.physics.player.eyeHeight };
    client.multiplayer.update(1400);

    expect(lines).toEqual(expect.arrayContaining([
      "you stole the enemy flag", "you dropped the enemy flag", "you returned your flag", "you scored for your team",
    ]));
  });

  it("applies server-authoritative spectator transitions to local physics", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    const enter = new PacketWriter().putInt(NetworkMessage.Spectator).putInt(4).putInt(1).finish();
    Reflect.apply(Reflect.get(client.multiplayer, "parseMessages"), client.multiplayer, [-1, new PacketReader(enter)]);

    expect(client.multiplayer.isSpectator).toBe(true);
    expect(client.physics.player.clientState).toBe(ClientState.Spectator);
    expect(client.physics.player.alive).toBe(false);
    expect(client.multiplayer.requestRespawn()).toBe(false);
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);
    client.multiplayer.update(0);
    expect(send.mock.calls.some(([channel]) => channel === 0)).toBe(false);

    const leave = new PacketWriter().putInt(NetworkMessage.Spectator).putInt(4).putInt(0).finish();
    Reflect.apply(Reflect.get(client.multiplayer, "parseMessages"), client.multiplayer, [-1, new PacketReader(leave)]);
    expect(client.multiplayer.isSpectator).toBe(false);
    expect(client.physics.player.clientState).toBe(ClientState.Dead);
  });

  it("consumes teleport and jumppad records on the position channel", () => {
    const client = createClient().multiplayer;
    const packet = new PacketWriter()
      .putInt(NetworkMessage.Teleport).putInt(7).putInt(2).putInt(3)
      .putInt(NetworkMessage.JumpPad).putInt(7).putInt(4)
      .finish();

    expect(() => Reflect.apply(Reflect.get(client, "parsePositions"), client, [new PacketReader(packet)])).not.toThrow();
  });

  it("sends position before a reliable channel-0 jumppad event", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    client.multiplayer.setMapEntities(createMovementEntities());
    client.physics.player.position = { x: 1, y: 2, z: 3 + client.physics.player.eyeHeight };
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);

    client.multiplayer.update(1000);

    expect(new PacketReader(send.mock.calls[0][1]).getInt()).toBe(NetworkMessage.Pos);
    expect(send.mock.calls[0][0]).toBe(0);
    const effect = send.mock.calls.find(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.JumpPad);
    expect(effect?.[0]).toBe(0);
    expect(effect?.[2]).toBe(true);
    const packet = new PacketReader(effect?.[1] ?? new Uint8Array());
    expect([packet.getInt(), packet.getInt(), packet.getInt()]).toEqual([NetworkMessage.JumpPad, 4, 0]);
    expect(packet.remaining).toBe(0);
  });

  it("consumes the complete edit-entity payload before the following message", () => {
    const client = createClient().multiplayer;
    const consoleLines: string[] = [];
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "console") consoleLines.push(detail.text);
    });
    const packet = new PacketWriter().putInt(NetworkMessage.EditEntity);
    for (let field = 0; field < 10; field++) packet.putInt(field);
    packet.putInt(NetworkMessage.ServerMessage).putString("aligned");

    expect(() => Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(packet.finish())])).not.toThrow();
    expect(consoleLines).toEqual(["aligned"]);
  });

  it("emits playsound events for native sound and explosion messages without losing packet alignment", () => {
    const client = createClient().multiplayer, sounds: number[] = [], lines: string[] = [];
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "playsound") sounds.push(detail.sound);
      if (detail.type === "console") lines.push(detail.text);
    });
    const packet = new PacketWriter()
      .putInt(NetworkMessage.Sound).putInt(GameSound.Jump)
      .putInt(NetworkMessage.ExplodeEffects).putInt(7).putInt(Gun.Rocket).putInt(42)
      .putInt(NetworkMessage.ServerMessage).putString("aligned")
      .finish();

    Reflect.apply(Reflect.get(client, "parseMessages"), client, [7, new PacketReader(packet)]);

    expect(sounds).toEqual([GameSound.Jump, GameSound.RocketHit]);
    expect(lines).toEqual(["aligned"]);
  });
});

function createMovementEntities() {
  return createFpsEntityRegistry([{ type: 23, position: { x: 1, y: 2, z: 3 }, attributes: [8, 0, 0, 0, 0] }]);
}

function readVector(packet: PacketReader, scale: number): { x: number; y: number; z: number } {
  return { x: packet.getInt() / scale, y: packet.getInt() / scale, z: packet.getInt() / scale };
}
