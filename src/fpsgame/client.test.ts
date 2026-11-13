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
import { TEAMKILL_PROTECTION_MESSAGE, TeamkillProtection } from "./teamkillProtection";
import { ChatModeration } from "./chatModeration";

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

  it("restores the authoritative spawn loadout after map placement resets local physics", () => {
    const client = createClient();
    client.multiplayer.connected = true;
    client.multiplayer.clientNumber = 4;
    vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);
    const spawn = new PacketWriter()
      .putInt(NetworkMessage.SpawnState).putInt(4)
      .putInt(1).putInt(1).putInt(100).putInt(0).putInt(0).putInt(Gun.Rifle)
      .putInt(0).putInt(0).putInt(0).putInt(100).putInt(0).putInt(0)
      .finish();

    Reflect.apply(Reflect.get(client.multiplayer, "parseMessages"), client.multiplayer, [-1, new PacketReader(spawn)]);
    client.physics.reset(1000);
    client.weapons.controller.respawn(1000);
    client.multiplayer.synchronizeLocalSpawnState();

    expect(client.physics.player).toMatchObject({ alive: true, clientState: ClientState.Alive, health: 1, armour: 0 });
    expect(client.weapons.controller.inventory.selectedGun).toBe(Gun.Rifle);
    expect(Array.from(client.weapons.controller.inventory.ammo.slice(0, 7))).toEqual([1, 0, 0, 0, 100, 0, 0]);
  });

  it("keeps a remote respawn hidden until its first position packet snaps to the spawn point", () => {
    const client = createClient();
    const multiplayer = client.multiplayer;
    const player = Reflect.apply(Reflect.get(multiplayer, "playerFor"), multiplayer, [7]) as NetworkPlayer;
    player.state = ClientState.Dead;
    player.positionReady = true;
    const spawn = new PacketWriter().putInt(NetworkMessage.Spawn);
    for (const value of [1, 100, 100, 0, 0, Gun.Pistol, 10, 10, 10, 10, 10, 10]) spawn.putInt(value);

    Reflect.apply(Reflect.get(multiplayer, "parseMessages"), multiplayer, [7, new PacketReader(spawn.finish())]);

    expect(player.state).toBe(ClientState.Spawning);
    expect(player.positionReady).toBe(false);
    client.physics.player.position = { x: 64, y: 96, z: 28 };
    const position = Reflect.apply(Reflect.get(multiplayer, "buildPosition"), multiplayer, [client.physics.player, 7, 1]) as Uint8Array;
    Reflect.apply(Reflect.get(multiplayer, "parsePositions"), multiplayer, [new PacketReader(position)]);
    expect(player.state).toBe(ClientState.Alive);
    expect(player.positionReady).toBe(true);
    expect(player.position).toEqual({ x: 64, y: 96, z: 28 });
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

  it.each([
    { text: "   ", feedback: "Message not sent: empty message." },
    { text: "H1TLER", feedback: "Message not sent: prohibited language." },
  ])("rejects invalid chat before local echo or transmission: $feedback", ({ text, feedback }) => {
    const client = createClient();
    client.multiplayer.connected = true;
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    const flush = vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);
    const lines: Array<{ text: string; consoleType: string }> = [];
    client.multiplayer.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "console") lines.push(detail);
    });

    expect(client.multiplayer.sendChat(text)).toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    expect(lines).toEqual([{ text: feedback, consoleType: "error", type: "console" }]);
  });

  it("rate-limits public and team messages through the same pre-serialization validator", () => {
    let now = 1_000;
    const moderation = new ChatModeration({ maxMessages: 1, windowMilliseconds: 5_000, bannedWords: [] }, () => now);
    const client = createClient(undefined, undefined, moderation);
    client.multiplayer.connected = true;
    const send = vi.spyOn(client.multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(client.multiplayer.transport, "flush").mockImplementation(() => undefined);
    const lines: string[] = [];
    client.multiplayer.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "console") lines.push(detail.text);
    });

    expect(client.multiplayer.sendChat("public", false)).toBe(true);
    now += 100;
    expect(client.multiplayer.sendChat("team", true)).toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe("Message not sent: chat rate limit exceeded. Try again in 5s.");
  });
});

describe("native server message framing", () => {
  it("surfaces a relay cooldown before the native server welcome completes", () => {
    const client = createClient().multiplayer, messages: string[] = [];
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "teamkill-protection") messages.push(detail.message);
    });
    const disconnect = vi.spyOn(client.transport, "disconnect").mockImplementation(() => undefined);

    Reflect.apply(Reflect.get(client, "handleEnet"), client, [{
      type: "control",
      data: { type: "teamkill-disconnect", cooldownMilliseconds: 60_000 },
    }]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([TEAMKILL_PROTECTION_MESSAGE]);
  });

  it("counts only server-confirmed teamkills by the local human player", () => {
    const protection = new TeamkillProtection();
    const fps = createClient(undefined, protection), client = fps.multiplayer;
    Reflect.set(client, "protectionTarget", "play.example:28785");
    client.clientNumber = 4;
    client.connected = true;
    const local = Reflect.apply(Reflect.get(client, "playerFor"), client, [4]) as NetworkPlayer;
    const teammate = Reflect.apply(Reflect.get(client, "playerFor"), client, [5]) as NetworkPlayer;
    const enemy = Reflect.apply(Reflect.get(client, "playerFor"), client, [6]) as NetworkPlayer;
    const bot = Reflect.apply(Reflect.get(client, "playerFor"), client, [7]) as NetworkPlayer;
    Object.assign(local, { team: "good", aiType: 0 });
    Object.assign(teammate, { team: "good", aiType: 0 });
    Object.assign(enemy, { team: "evil", aiType: 0 });
    Object.assign(bot, { team: "good", aiType: 1 });
    const protectionEvents: string[] = [];
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "teamkill-protection") protectionEvents.push(detail.message);
    });
    const report = vi.spyOn(client.transport, "reportTeamkill").mockImplementation(() => undefined);
    const disconnect = vi.spyOn(client.transport, "disconnect").mockImplementation(() => undefined);
    const died = (victim: number, actor: number): void => {
      const packet = new PacketWriter().putInt(NetworkMessage.Died).putInt(victim).putInt(actor).putInt(0).putInt(0).finish();
      Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(packet)]);
    };

    died(4, 4);
    died(6, 4);
    died(7, 4);
    expect(protection.count("play.example:28785")).toBe(0);
    died(5, 4);

    expect(protection.count("play.example:28785")).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    died(5, 4);
    died(5, 4);

    expect(report).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(false);
    expect(protectionEvents).toEqual([TEAMKILL_PROTECTION_MESSAGE]);
  });

  it("serializes N_ITEMPICKUP, optimistically hides it, and waits for N_ITEMACC before awarding stats", () => {
    const client = createClient(), multiplayer = client.multiplayer;
    multiplayer.connected = true;
    multiplayer.clientNumber = 4;
    const player = Reflect.apply(Reflect.get(multiplayer, "playerFor"), multiplayer, [4]) as NetworkPlayer;
    Object.assign(player, { state: ClientState.Alive, alive: true });
    const items = createFpsEntityRegistry([{ type: 8, position: { x: 4, y: 5, z: 6 }, attributes: [0, 0, 0, 0, 0] }]);
    multiplayer.setMapEntities(items);
    const list = new PacketWriter().putInt(NetworkMessage.ItemList).putInt(0).putInt(8).putInt(-1).finish();
    Reflect.apply(Reflect.get(multiplayer, "parseMessages"), multiplayer, [-1, new PacketReader(list)]);
    client.physics.player.position = { x: 4, y: 5, z: 6 + client.physics.player.eyeHeight };
    const send = vi.spyOn(multiplayer.transport, "send").mockImplementation(() => undefined);
    vi.spyOn(multiplayer.transport, "flush").mockImplementation(() => undefined);

    multiplayer.update(1_000);

    const request = send.mock.calls.find(([, bytes]) => new PacketReader(bytes).getInt() === NetworkMessage.ItemPickup);
    expect(request?.[0]).toBe(1);
    expect(request?.[2]).toBe(true);
    const packet = new PacketReader(request?.[1] ?? new Uint8Array());
    expect([packet.getInt(), packet.getInt()]).toEqual([NetworkMessage.ItemPickup, 0]);
    expect(packet.remaining).toBe(0);
    expect(client.weapons.controller.inventory.ammo[Gun.Shotgun]).toBe(0);
    expect(multiplayer.entities.itemState(0)).toMatchObject({ spawned: true, noPickup: true });

    const accept = new PacketWriter().putInt(NetworkMessage.ItemAccept).putInt(0).putInt(4).finish();
    Reflect.apply(Reflect.get(multiplayer, "parseMessages"), multiplayer, [-1, new PacketReader(accept)]);
    expect(client.weapons.controller.inventory.ammo[Gun.Shotgun]).toBe(10);
    expect(multiplayer.entities.itemState(0)).toMatchObject({ spawned: false, noPickup: false });
  });

  it("restores optimistic item visibility when the server rejects a competing pickup", () => {
    const client = createClient().multiplayer;
    client.setMapEntities(createFpsEntityRegistry([{ type: 14, position: { x: 0, y: 0, z: 0 }, attributes: [0, 0, 0, 0, 0] }]));
    const list = new PacketWriter().putInt(NetworkMessage.ItemList).putInt(0).putInt(14).putInt(-1).finish();
    Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(list)]);
    client.entities.optimisticPickup(0);

    const rejection = new PacketWriter().putInt(NetworkMessage.ItemAccept).putInt(0).putInt(-1).finish();
    Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(rejection)]);

    expect(client.entities.itemState(0)).toMatchObject({ spawned: true, noPickup: false });
  });

  it("tracks remote quad duration and emits its native expiration sound", () => {
    const client = createClient().multiplayer, sounds: number[] = [];
    const player = Reflect.apply(Reflect.get(client, "playerFor"), client, [7]) as NetworkPlayer;
    Object.assign(player, { state: ClientState.Alive, alive: true, position: { x: 100, y: 100, z: 20 } });
    client.setMapEntities(createFpsEntityRegistry([{ type: 18, position: { x: 100, y: 100, z: 6 }, attributes: [0, 0, 0, 0, 0] }]));
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "playsound") sounds.push(detail.sound);
    });
    const accept = new PacketWriter().putInt(NetworkMessage.ItemAccept).putInt(0).putInt(7).finish();
    Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(accept)]);

    expect(player.quadMillis).toBe(20_000);
    client.update(1_000);
    client.update(21_000);

    expect(player.quadMillis).toBe(0);
    expect(sounds).toContain(GameSound.PowerupOut);
  });

  it("keeps the native insta-CTF rifle loadout when a local match starts and respawns", () => {
    const client = createClient();
    client.multiplayer.gameMode = 12;
    client.weapons.controller.spawnForGameMode(12);

    client.multiplayer.startLocalGame("local player");

    expect(client.weapons.controller.inventory.selectedGun).toBe(Gun.Rifle);
    expect(Array.from(client.weapons.controller.inventory.ammo.slice(0, 7))).toEqual([1, 0, 0, 0, 100, 0, 0]);
    client.physics.player.alive = false;
    expect(client.multiplayer.requestRespawn()).toBe(true);
    expect(client.weapons.controller.inventory.selectedGun).toBe(Gun.Rifle);
    expect(Array.from(client.weapons.controller.inventory.ammo.slice(0, 7))).toEqual([1, 0, 0, 0, 100, 0, 0]);
  });

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

  it("consumes native auth requests and server commands without losing packet alignment", () => {
    const client = createClient().multiplayer;
    const consoleLines: string[] = [];
    client.addEventListener("multiplayer", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "console") consoleLines.push(detail.text);
    });
    const packet = new PacketWriter()
      .putInt(NetworkMessage.RequestAuth).putString("auth-domain")
      .putInt(NetworkMessage.ServerCommand).putString("server-command")
      .putInt(NetworkMessage.ServerMessage).putString("aligned")
      .finish();

    expect(() => Reflect.apply(Reflect.get(client, "parseMessages"), client, [-1, new PacketReader(packet)])).not.toThrow();
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

    // Native explodeeffects() only plays the impact sound after matching an active owner + gun + projectile id.
    expect(sounds).toEqual([GameSound.Jump]);
    expect(lines).toEqual(["aligned"]);
  });
});

function createMovementEntities() {
  return createFpsEntityRegistry([{ type: 23, position: { x: 1, y: 2, z: 3 }, attributes: [8, 0, 0, 0, 0] }]);
}

function readVector(packet: PacketReader, scale: number): { x: number; y: number; z: number } {
  return { x: packet.getInt() / scale, y: packet.getInt() / scale, z: packet.getInt() / scale };
}
