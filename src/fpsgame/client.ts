import { PhysicsSimulation } from "../engine/physics";
import { ClientState, PhysicsState } from "../engine/physics/types";
import { copyVec3, magnitude } from "../engine/physics/vector";
import type { Vec3 } from "../engine/octa";
import { EnetClient, type EnetEvent, ENET_PACKET_FLAG_UNSEQUENCED } from "../network/enet";
import { PacketReader, PacketWriter } from "../network/protocol";
import { DMF, DNF, DVELF, gameModeName, NetworkMessage, PROTOCOL_VERSION } from "./game";
import { WeaponSystem } from "./weapon";
import { createDamageable, hitpush, type Damageable } from "./weapon/DamageSystem";
import { Gun, WEAPONS } from "./weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponHit } from "./weapon/WeaponEvents";

export interface FpsClient { physics: PhysicsSimulation; weapons: WeaponSystem; multiplayer: MultiplayerClient }
export interface ServerEndpoint {
  host: string;
  port: number;
  relayUrl?: string;
  playerName: string;
  playerModel?: number;
  map?: string;
  mode?: number;
}

export interface NetworkPlayer extends Damageable {
  clientNumber: number;
  name: string;
  team: string;
  model: number;
  lifeSequence: number;
  state: ClientState;
  frags: number;
  deaths: number;
  flags: number;
  ping: number;
  yaw: number;
  pitch: number;
  roll: number;
  move: -1 | 0 | 1;
  strafe: -1 | 0 | 1;
  physicsState: PhysicsState;
  selectedGun: number;
  ammo: Int32Array;
  lastAction: number;
  gunWait: number;
  lastAttackGun: number;
  lastPain: number;
  deadAt: number;
}

export type MultiplayerEvent =
  | { type: "status"; status: string }
  | { type: "map-change"; map: string; mode: number }
  | { type: "players" }
  | { type: "spawn" }
  | { type: "message"; text: string }
  | { type: "remote-shot"; clientNumber: number; gun: Gun; from: Vec3; to: Vec3 }
  | { type: "disconnect"; reason: number };

export function createClient(physics = new PhysicsSimulation()): FpsClient {
  const weapons = new WeaponSystem({
    raycast: (origin, direction, distance, radius) => physics.raycast(origin, direction, distance, radius),
  }, physics.player);
  return { physics, weapons, multiplayer: new MultiplayerClient(physics, weapons) };
}

// Original: src/fpsgame/client.cpp
// Functions: parsepacketclient(), parsepositions(), parsemessages(), c2sinfo()
// Sauerbraten reference: SVN r6488
export class MultiplayerClient extends EventTarget {
  readonly players = new Map<number, NetworkPlayer>();
  readonly transport = new EnetClient();
  connected = false;
  clientNumber = -1;
  sessionId = 0;
  mapName = "";
  gameMode = 0;
  serverDescription = "";
  timeLeftSeconds = 0;
  private endpoint?: ServerEndpoint;
  private lastUpdate = -1000;
  private lastPing = 0;
  private mapStarted = performance.now();
  private lastSpawnAttempt = Number.NEGATIVE_INFINITY;
  private respawnRequested = false;
  private mapEntityTypes: number[] = [];
  private loadedMapName = "";
  private loadedMapCrc = 0;
  private mapInfoPending = false;

  constructor(readonly physics: PhysicsSimulation, readonly weapons: WeaponSystem) {
    super();
    this.transport.addEventListener("enet", (event) => this.handleEnet((event as CustomEvent<EnetEvent>).detail));
    this.weapons.events.on((event) => this.handleWeaponEvent(event));
  }

  async connect(endpoint: ServerEndpoint): Promise<void> {
    this.disconnect();
    this.weapons.controller.serverAuthoritative = true;
    this.endpoint = { ...endpoint, playerName: endpoint.playerName.slice(0, 15) || "unnamed" };
    this.emit({ type: "status", status: `connecting to ${endpoint.host}:${endpoint.port}` });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      await this.transport.connect(endpoint.relayUrl ?? `${protocol}//${location.host}/relay`, endpoint.host, endpoint.port);
    } catch (error) {
      this.weapons.controller.serverAuthoritative = false;
      this.emit({ type: "status", status: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  disconnect(): void {
    this.transport.close();
    this.connected = false;
    this.clientNumber = -1;
    this.players.clear();
    this.respawnRequested = false;
    this.lastSpawnAttempt = Number.NEGATIVE_INFINITY;
    this.mapInfoPending = Boolean(this.loadedMapName);
    this.weapons.controller.serverAuthoritative = false;
    this.syncTargets();
  }

  // Original: src/fpsgame/client.cpp, src/fpsgame/fps.cpp
  // Functions: sendmessages(), respawnself()
  // Sauerbraten reference: SVN r6488
  update(nowMilliseconds: number): void {
    if (this.clientNumber < 0 || nowMilliseconds - this.lastUpdate < 33) return;
    this.lastUpdate = nowMilliseconds;
    if (this.physics.player.alive) this.transport.send(0, this.buildPosition());
    const messages = new PacketWriter();
    if (nowMilliseconds - this.lastPing > 250) {
      messages.putInt(NetworkMessage.Ping).putInt(Math.trunc(nowMilliseconds));
      this.lastPing = nowMilliseconds;
    }
    if (this.mapInfoPending && this.mapName.toLocaleLowerCase() === this.loadedMapName.toLocaleLowerCase()) {
      this.transport.send(1, new PacketWriter().putInt(NetworkMessage.MapCrc).putString(this.loadedMapName)
        .putInt(this.loadedMapCrc).finish(), true);
      this.mapInfoPending = false;
    }
    if (!this.physics.player.alive && (this.respawnRequested || this.weapons.controller.attacking) &&
        nowMilliseconds - this.lastSpawnAttempt >= 1000) {
      this.transport.send(1, new PacketWriter().putInt(NetworkMessage.TrySpawn).finish(), true);
      this.lastSpawnAttempt = nowMilliseconds;
    }
    const bytes = messages.finish();
    if (bytes.length) this.transport.send(1, bytes);
    this.transport.flush();
  }

  get scoreboard(): readonly NetworkPlayer[] {
    return [...this.players.values()].sort((left, right) => right.frags - left.frags || left.name.localeCompare(right.name));
  }

  sendChat(text: string): void {
    const message = text.trim();
    if (!this.connected || !message) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.Text).putString(message).finish(), true);
    this.transport.flush();
  }

  // Original: src/fpsgame/fps.cpp
  // Function: respawn() / respawnself()
  // Sauerbraten reference: SVN r6488
  requestRespawn(): boolean {
    if (!this.connected || this.physics.player.alive) return false;
    if (!this.respawnRequested) this.lastSpawnAttempt = Number.NEGATIVE_INFINITY;
    this.respawnRequested = true;
    return true;
  }

  // Original: src/fpsgame/client.cpp
  // Function: sendmapinfo() / sendmessages()
  // Sauerbraten reference: SVN r6488
  setMapInfo(name: string, crc: number): void {
    this.loadedMapName = name;
    this.loadedMapCrc = crc;
    this.mapInfoPending = true;
  }

  setMapEntities(entities: readonly { type: number }[]): void {
    this.mapEntityTypes = entities.map((entity) => entity.type);
  }

  private handleEnet(event: EnetEvent): void {
    if (event.type === "connect") {
      this.emit({ type: "status", status: "ENet connected; waiting for server" });
      return;
    }
    if (event.type === "disconnect") {
      this.connected = false;
      this.weapons.controller.serverAuthoritative = false;
      this.emit({ type: "disconnect", reason: event.data });
      return;
    }
    if (event.type !== "receive") return;
    if (event.flags & ENET_PACKET_FLAG_UNSEQUENCED) return;
    try {
      if (event.channel === 0) this.parsePositions(new PacketReader(event.data));
      else if (event.channel === 1) this.parseMessages(-1, new PacketReader(event.data));
    } catch (error) {
      this.emit({ type: "status", status: error instanceof Error ? error.message : String(error) });
    }
  }

  private parsePositions(packet: PacketReader): void {
    while (packet.remaining) {
      const type = packet.getInt();
      if (type === NetworkMessage.DemoPacket) continue;
      if (type !== NetworkMessage.Pos) throw new Error(`Unexpected channel 0 message ${type}.`);
      const clientNumber = packet.getUInt(), physicalState = packet.getByte(), flags = packet.getUInt();
      const position = { x: 0, y: 0, z: 0 };
      for (const [component, key] of (["x", "y", "z"] as const).entries()) {
        let value = packet.getByte() | (packet.getByte() << 8);
        if (flags & (1 << component)) {
          value |= packet.getByte() << 16;
          if (value & 0x800000) value |= ~0xFFFFFF;
        }
        position[key] = value / DMF;
      }
      let direction = packet.getByte() | (packet.getByte() << 8);
      const yaw = direction % 360, pitch = Math.min(180, Math.max(0, Math.trunc(direction / 360))) - 90;
      const roll = Math.min(180, Math.max(0, packet.getByte())) - 90;
      let speed = packet.getByte();
      if (flags & (1 << 3)) speed |= packet.getByte() << 8;
      direction = packet.getByte() | (packet.getByte() << 8);
      const velocity = directionVector(direction % 360, Math.min(180, Math.max(0, Math.trunc(direction / 360))) - 90, speed / DVELF);
      if (flags & (1 << 4)) {
        packet.getByte();
        if (flags & (1 << 5)) packet.getByte();
        if (flags & (1 << 6)) { packet.getByte(); packet.getByte(); }
      }
      const player = this.players.get(clientNumber);
      const wrongLifeSequence = ((physicalState >> 3) & 1) !== ((player?.lifeSequence ?? 0) & 1);
      if (!player || player.lifeSequence < 0 || wrongLifeSequence || player.state === ClientState.Dead) continue;
      player.position = { ...position, z: position.z + player.eyeHeight };
      player.velocity = velocity;
      player.yaw = yaw;
      player.pitch = pitch;
      player.roll = roll;
      player.move = (physicalState >> 4) & 2 ? -1 : (physicalState >> 4) & 1 ? 1 : 0;
      player.strafe = (physicalState >> 6) & 2 ? -1 : (physicalState >> 6) & 1 ? 1 : 0;
      player.physicsState = physicalState & 7;
      if (player.state === ClientState.Lagged || player.state === ClientState.Spawning) {
        player.state = ClientState.Alive;
        player.alive = true;
      }
      this.emit({ type: "players" });
    }
  }

  private parseMessages(sender: number, packet: PacketReader): void {
    while (packet.remaining) {
      const type = packet.getInt();
      switch (type) {
        case NetworkMessage.ServInfo: this.parseServerInfo(packet); break;
        case NetworkMessage.Welcome:
          this.connected = true;
          this.emit({ type: "status", status: this.serverDescription || "connected" });
          if (!this.mapName && this.endpoint?.map && this.endpoint.mode !== undefined) {
            this.transport.send(1, new PacketWriter().putInt(NetworkMessage.MapVote).putString(this.endpoint.map)
              .putInt(this.endpoint.mode).finish(), true);
            this.transport.flush();
          }
          break;
        case NetworkMessage.Client: {
          const clientNumber = packet.getInt();
          this.parseMessages(clientNumber, packet.subReader(packet.getUInt()));
          break;
        }
        case NetworkMessage.MapChange:
          this.mapName = packet.getString();
          this.gameMode = packet.getInt();
          packet.getInt();
          this.mapInfoPending = this.loadedMapName.toLocaleLowerCase() === this.mapName.toLocaleLowerCase();
          this.mapStarted = performance.now();
          this.emit({ type: "map-change", map: this.mapName, mode: this.gameMode });
          break;
        case NetworkMessage.InitClient: this.parseInitClient(packet); break;
        case NetworkMessage.ClientDisconnect:
          this.players.delete(packet.getInt()); this.syncTargets(); this.emit({ type: "players" }); break;
        case NetworkMessage.SpawnState: this.parseSpawnState(packet); break;
        case NetworkMessage.Spawn: {
          const player = this.players.get(sender);
          this.parseState(player, packet);
          if (player) { player.state = ClientState.Spawning; player.alive = false; }
          break;
        }
        case NetworkMessage.ForceDeath: this.setDead(packet.getInt(), false); break;
        case NetworkMessage.Shoot: this.parseShoot(sender, packet); break;
        case NetworkMessage.ShotEffects: this.parseShotEffects(packet); break;
        case NetworkMessage.Damage: this.parseDamage(packet); break;
        case NetworkMessage.HitPush: this.parseHitPush(packet); break;
        case NetworkMessage.Died: this.parseDied(packet); break;
        case NetworkMessage.Resume: this.parseResume(packet); break;
        case NetworkMessage.TeamInfo: this.skipTeamInfo(packet); break;
        case NetworkMessage.ItemList: while (packet.getInt() >= 0) packet.getInt(); break;
        case NetworkMessage.ItemSpawn: packet.getInt(); break;
        case NetworkMessage.ItemAccept: this.parseItemAccept(packet); break;
        case NetworkMessage.CurrentMaster:
          packet.getInt();
          for (let clientNumber = packet.getInt(); clientNumber >= 0; clientNumber = packet.getInt()) packet.getInt();
          break;
        case NetworkMessage.Pong: packet.getInt(); break;
        case NetworkMessage.TimeUp: this.timeLeftSeconds = packet.getInt(); break;
        case NetworkMessage.ServerMessage: this.emit({ type: "message", text: packet.getString() }); break;
        case NetworkMessage.Sound: packet.getInt(); break;
        case NetworkMessage.GunSelect: {
          const player = this.players.get(sender), gun = packet.getInt();
          if (player) player.selectedGun = gun;
          break;
        }
        case NetworkMessage.ReplenishAmmo: this.parseReplenishAmmo(packet); break;
        case NetworkMessage.BaseRegen: this.parseBaseRegen(packet); break;
        case NetworkMessage.ClientPing: {
          const player = this.players.get(sender), ping = packet.getInt();
          if (player) player.ping = ping;
          break;
        }
        case NetworkMessage.SwitchName: {
          const player = this.players.get(sender), name = packet.getString();
          if (player) player.name = name;
          break;
        }
        case NetworkMessage.SwitchModel: {
          const player = this.players.get(sender), model = packet.getInt();
          if (player) player.model = model;
          break;
        }
        case NetworkMessage.SetTeam: {
          const player = this.players.get(packet.getInt()), team = packet.getString();
          packet.getInt(); if (player) player.team = team; break;
        }
        case NetworkMessage.PauseGame: packet.getInt(); packet.getInt(); break;
        case NetworkMessage.GameSpeed: packet.getInt(); packet.getInt(); break;
        case NetworkMessage.Spectator: {
          const player = this.playerFor(packet.getInt());
          player.state = packet.getInt() ? ClientState.Spectator : ClientState.Dead;
          player.alive = false;
          break;
        }
        case NetworkMessage.DemoPacket: break;
        default: throw new Error(`Unsupported server message ${type} on protocol 260.`);
      }
    }
  }

  private parseServerInfo(packet: PacketReader): void {
    this.clientNumber = packet.getInt();
    const protocol = packet.getInt();
    if (protocol !== PROTOCOL_VERSION) {
      this.transport.disconnect();
      throw new Error(`Protocol mismatch: SauerWeb uses ${PROTOCOL_VERSION}, server uses ${protocol}.`);
    }
    this.sessionId = packet.getInt();
    const passwordProtected = packet.getInt() > 0;
    this.serverDescription = packet.getString();
    packet.getString();
    if (passwordProtected) throw new Error("Password-protected servers are not supported yet.");
    const intro = new PacketWriter().putInt(NetworkMessage.Connect).putString(this.endpoint?.playerName ?? "unnamed")
      .putInt(this.endpoint?.playerModel ?? 0).putString("").putString("").putString("");
    this.transport.send(1, intro.finish(), true);
    this.transport.flush();
  }

  private parseInitClient(packet: PacketReader): void {
    const player = this.playerFor(packet.getInt());
    player.name = packet.getString() || "unnamed";
    player.team = packet.getString();
    player.model = packet.getInt();
    this.emit({ type: "players" });
  }

  private parseSpawnState(packet: PacketReader): void {
    const clientNumber = packet.getInt(), player = this.playerFor(clientNumber);
    this.parseState(player, packet);
    player.state = ClientState.Alive;
    player.alive = true;
    player.deadAt = 0;
    if (clientNumber === this.clientNumber) {
      this.respawnRequested = false;
      this.physics.player.alive = true;
      this.physics.player.clientState = ClientState.Alive;
      this.weapons.controller.respawn(performance.now());
      this.physics.player.health = player.health;
      this.physics.player.maxHealth = player.maxHealth;
      this.physics.player.armour = player.armour;
      this.physics.player.armourType = player.armourType;
      this.weapons.controller.inventory.selectedGun = player.selectedGun;
      this.weapons.controller.inventory.ammo.set(player.ammo);
      this.emit({ type: "spawn" });
    }
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.Spawn).putInt(player.lifeSequence).putInt(player.selectedGun).finish(), true);
    this.transport.flush();
  }

  private parseState(player: NetworkPlayer | undefined, packet: PacketReader, resume = false): void {
    if (resume) {
      const state = packet.getInt(), frags = packet.getInt(), flags = packet.getInt(), deaths = packet.getInt();
      packet.getInt();
      if (player) {
        player.state = state;
        player.alive = state === ClientState.Alive;
        player.frags = frags;
        player.flags = flags;
        player.deaths = deaths;
      }
    }
    const lifeSequence = packet.getInt(), health = packet.getInt(), maxHealth = packet.getInt(), armour = packet.getInt(),
      armourType = packet.getInt();
    const selectedGun = packet.getInt(), ammo = new Int32Array(12);
    for (let gun = Gun.Shotgun; gun <= Gun.Pistol; gun++) ammo[gun] = packet.getInt();
    ammo[Gun.Fist] = 1;
    if (!player) return;
    Object.assign(player, { lifeSequence, health, maxHealth, armour, armourType, selectedGun, ammo });
  }

  private parseResume(packet: PacketReader): void {
    while (packet.remaining) {
      const clientNumber = packet.getInt();
      if (clientNumber < 0) break;
      this.parseState(this.playerFor(clientNumber), packet, true);
    }
    this.emit({ type: "players" });
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_SHOTFX
  // Sauerbraten reference: SVN r6488
  private parseShotEffects(packet: PacketReader): void {
    const clientNumber = packet.getInt(), gun = packet.getInt() as Gun;
    packet.getInt();
    const from = { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
    const to = { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
    const player = this.players.get(clientNumber);
    if (player) this.applyShotEffects(player, gun);
    this.weapons.events.emit({ type: "shot-effect", gun, from, to, rays: [] });
    this.emit({ type: "remote-shot", clientNumber, gun, from, to });
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_SHOTFX
  // Sauerbraten reference: SVN r6488
  private applyShotEffects(player: NetworkPlayer, gun: Gun): void {
    if (gun > Gun.Fist && gun <= Gun.Pistol && player.ammo[gun]) player.ammo[gun]--;
    player.selectedGun = Math.min(Gun.Pistol, Math.max(Gun.Fist, gun));
    player.gunWait = this.weaponDelay(player.selectedGun);
    player.lastAction = performance.now();
    player.lastAttackGun = player.selectedGun;
  }

  // Original: src/fpsgame/server.cpp
  // Function: parsepacket(), N_SHOOT
  // Sauerbraten reference: SVN r6488
  private parseShoot(sender: number, packet: PacketReader): void {
    packet.getInt();
    const gun = packet.getInt() as Gun;
    const from = { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
    const to = { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
    const hitCount = packet.getInt();
    for (let hit = 0; hit < hitCount; hit++) for (let field = 0; field < 7; field++) packet.getInt();
    const player = this.players.get(sender);
    if (player) this.applyShotEffects(player, gun);
    this.weapons.events.emit({ type: "shot-effect", gun, from, to, rays: [] });
    this.emit({ type: "remote-shot", clientNumber: sender, gun, from, to });
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_DAMAGE
  // Sauerbraten reference: SVN r6488
  private parseDamage(packet: PacketReader): void {
    const targetNumber = packet.getInt();
    packet.getInt(); packet.getInt();
    const armour = packet.getInt(), health = packet.getInt(), target = this.playerFor(targetNumber);
    target.armour = armour; target.health = health;
    target.lastPain = performance.now();
    if (targetNumber === this.clientNumber) { this.physics.player.armour = armour; this.physics.player.health = health; }
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_HITPUSH
  // Sauerbraten reference: SVN r6488
  private parseHitPush(packet: PacketReader): void {
    const targetNumber = packet.getInt(), gun = packet.getInt() as Gun, damage = packet.getInt();
    const direction = { x: packet.getInt() / DNF, y: packet.getInt() / DNF, z: packet.getInt() / DNF };
    const target = this.players.get(targetNumber);
    if (target) hitpush(target, damage * (target.health <= 0 ? 2 : 1), direction, gun);
    if (targetNumber === this.clientNumber) hitpush(this.physics.player, damage * (this.physics.player.health <= 0 ? 2 : 1), direction, gun);
  }

  // Original: src/fpsgame/capture.h
  // Function: parsepacketclient(), N_REPAMMO
  // Sauerbraten reference: SVN r6488
  private parseReplenishAmmo(packet: PacketReader): void {
    const clientNumber = packet.getInt(), gun = packet.getInt() as Gun, player = this.players.get(clientNumber);
    if (!player || gun < Gun.Shotgun || gun > Gun.Pistol) return;
    const pickup = this.weapons.controller.inventory.pickup(gun);
    player.ammo[gun] = Math.min(pickup.max, player.ammo[gun] + pickup.add);
    if (clientNumber === this.clientNumber) this.weapons.controller.inventory.ammo[gun] = player.ammo[gun];
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_ITEMACC
  // Sauerbraten reference: SVN r6488
  private parseItemAccept(packet: PacketReader): void {
    const entityIndex = packet.getInt(), clientNumber = packet.getInt();
    if (clientNumber < 0) return;
    const entityType = this.mapEntityTypes[entityIndex];
    if (!Number.isInteger(entityType) || entityType < 8 || entityType > 13) return;
    const gun = entityType - 8 + Gun.Shotgun;
    const player = this.players.get(clientNumber);
    if (!player || gun < Gun.Shotgun || gun > Gun.Pistol) return;
    const pickup = this.weapons.controller.inventory.pickup(gun);
    player.ammo[gun] = Math.min(pickup.max, player.ammo[gun] + pickup.add);
    if (clientNumber === this.clientNumber) this.weapons.controller.inventory.ammo[gun] = player.ammo[gun];
  }

  // Original: src/fpsgame/capture.h
  // Function: parsepacketclient(), N_BASEREGEN
  // Sauerbraten reference: SVN r6488
  private parseBaseRegen(packet: PacketReader): void {
    const clientNumber = packet.getInt(), health = packet.getInt(), armour = packet.getInt(), gun = packet.getInt() as Gun,
      ammo = packet.getInt(), player = this.players.get(clientNumber);
    if (!player) return;
    player.health = health;
    player.armourType = 1;
    player.armour = armour;
    if (gun >= Gun.Shotgun && gun <= Gun.Pistol) player.ammo[gun] = ammo;
    if (clientNumber === this.clientNumber) {
      this.physics.player.health = health;
      this.physics.player.armourType = 1;
      this.physics.player.armour = armour;
      if (gun >= Gun.Shotgun && gun <= Gun.Pistol) this.weapons.controller.inventory.ammo[gun] = ammo;
    }
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_DIED
  // Sauerbraten reference: SVN r6488
  private parseDied(packet: PacketReader): void {
    const victimNumber = packet.getInt(), actor = this.playerFor(packet.getInt());
    actor.frags = packet.getInt(); packet.getInt(); this.setDead(victimNumber);
  }

  private setDead(clientNumber: number, countDeath = true): void {
    const player = this.playerFor(clientNumber);
    const wasDead = player.state === ClientState.Dead;
    player.state = ClientState.Dead; player.alive = false;
    if (countDeath && !wasDead) player.deaths++;
    player.deadAt = performance.now();
    if (clientNumber === this.clientNumber) {
      this.physics.player.alive = false;
      this.physics.player.clientState = ClientState.Dead;
      this.weapons.controller.setAttacking(false);
    }
    this.emit({ type: "players" });
  }

  private skipTeamInfo(packet: PacketReader): void { for (let team = packet.getString(); team; team = packet.getString()) packet.getInt(); }

  private buildPosition(): Uint8Array {
    const player = this.physics.player, networkPlayer = this.playerFor(this.clientNumber);
    const packet = new PacketWriter().putInt(NetworkMessage.Pos).putUInt(this.clientNumber);
    const physicalState = player.physicsState | ((networkPlayer.lifeSequence & 1) << 3) | ((player.move & 3) << 4) |
      ((player.strafe & 3) << 6);
    packet.putByte(physicalState);
    const position = [Math.trunc(player.position.x * DMF), Math.trunc(player.position.y * DMF),
      Math.trunc((player.position.z - player.eyeHeight) * DMF)];
    const velocityMagnitude = Math.min(Math.trunc(magnitude(player.velocity) * DVELF), 0xFFFF);
    const fallingMagnitude = Math.min(Math.trunc(magnitude(player.falling) * DVELF), 0xFFFF);
    let flags = 0;
    position.forEach((value, index) => { if (value < 0 || value > 0xFFFF) flags |= 1 << index; });
    if (velocityMagnitude > 0xFF) flags |= 1 << 3;
    if (fallingMagnitude > 0) {
      flags |= 1 << 4;
      if (fallingMagnitude > 0xFF) flags |= 1 << 5;
      if (player.falling.x || player.falling.y || player.falling.z > 0) flags |= 1 << 6;
    }
    packet.putUInt(flags);
    position.forEach((value, index) => { packet.putByte(value).putByte(value >> 8); if (flags & (1 << index)) packet.putByte(value >> 16); });
    putDirection(packet, player.yaw, player.pitch);
    packet.putByte(Math.min(180, Math.max(0, Math.trunc(player.roll + 90)))).putByte(velocityMagnitude);
    if (velocityMagnitude > 0xFF) packet.putByte(velocityMagnitude >> 8);
    const velocityDirection = yawPitch(player.velocity);
    putDirection(packet, velocityDirection.yaw, velocityDirection.pitch);
    if (fallingMagnitude > 0) {
      packet.putByte(fallingMagnitude);
      if (fallingMagnitude > 0xFF) packet.putByte(fallingMagnitude >> 8);
      if (flags & (1 << 6)) { const fallingDirection = yawPitch(player.falling); putDirection(packet, fallingDirection.yaw, fallingDirection.pitch); }
    }
    return packet.finish();
  }

  private handleWeaponEvent(event: WeaponEvent): void {
    if (!this.connected) return;
    if (event.type === "selected") {
      this.transport.send(1, new PacketWriter().putInt(NetworkMessage.GunSelect).putInt(event.gun).finish(), true);
      return;
    }
    if (event.type !== "shot") return;
    this.transport.send(1, serializeShoot(event, Math.trunc(event.millis - this.mapStarted)), true);
  }

  private playerFor(clientNumber: number): NetworkPlayer {
    let player = this.players.get(clientNumber);
    if (player) return player;
    player = Object.assign(createDamageable(`client:${clientNumber}`, copyVec3(this.physics.player.position)), {
      clientNumber, name: clientNumber === this.clientNumber ? this.endpoint?.playerName ?? "unnamed" : "unnamed", team: "", model: 0,
      lifeSequence: -1, state: ClientState.Dead, frags: 0, deaths: 0, flags: 0, ping: 0, yaw: 0, pitch: 0, roll: 0, move: 0 as const,
      strafe: 0 as const, physicsState: PhysicsState.Fall, selectedGun: Gun.Pistol, ammo: new Int32Array(12),
      lastAction: 0, gunWait: 0, lastAttackGun: -1, lastPain: 0, deadAt: 0,
    });
    player.alive = false;
    this.players.set(clientNumber, player);
    this.syncTargets();
    return player;
  }

  private syncTargets(): void {
    this.weapons.targets.splice(1, this.weapons.targets.length - 1,
      ...[...this.players.values()].filter((player) => player.clientNumber !== this.clientNumber));
  }

  private emit(detail: MultiplayerEvent): void { this.dispatchEvent(new CustomEvent<MultiplayerEvent>("multiplayer", { detail })); }

  private weaponDelay(gun: number): number {
    return gun >= Gun.Fist && gun <= Gun.Pistol ? WEAPONS[gun].attackDelay : 0;
  }
}

// Original: src/fpsgame/weapon.cpp
// Function: shoot(), addmsg(N_SHOOT, "rci2i6iv", ...)
// Sauerbraten reference: SVN r6488
export function serializeShoot(event: Extract<WeaponEvent, { type: "shot" }>, shotMillis: number): Uint8Array {
  const packet = new PacketWriter().putInt(NetworkMessage.Shoot).putInt(shotMillis).putInt(event.gun)
    .putInt(Math.trunc(event.from.x * DMF)).putInt(Math.trunc(event.from.y * DMF)).putInt(Math.trunc(event.from.z * DMF))
    .putInt(Math.trunc(event.to.x * DMF)).putInt(Math.trunc(event.to.y * DMF)).putInt(Math.trunc(event.to.z * DMF));
  const hits = event.hits.filter((hit): hit is WeaponHit & { target: NetworkPlayer } => hit.target.id.startsWith("client:"));
  packet.putInt(hits.length);
  for (const hit of hits) {
    const target = hit.target;
    packet.putInt(target.clientNumber).putInt(target.lifeSequence).putInt(Math.trunc(hit.distance * DMF)).putInt(hit.rays)
      .putInt(Math.trunc(hit.direction.x * DNF)).putInt(Math.trunc(hit.direction.y * DNF)).putInt(Math.trunc(hit.direction.z * DNF));
  }
  return packet.finish();
}

function directionVector(yaw: number, pitch: number, length: number): Vec3 {
  const yawRadians = yaw * Math.PI / 180, pitchRadians = pitch * Math.PI / 180;
  return { x: -Math.sin(yawRadians) * Math.cos(pitchRadians) * length, y: Math.cos(yawRadians) * Math.cos(pitchRadians) * length,
    z: Math.sin(pitchRadians) * length };
}

function yawPitch(vector: Vec3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(-vector.x, vector.y) * 180 / Math.PI,
    pitch: Math.atan2(vector.z, Math.hypot(vector.x, vector.y)) * 180 / Math.PI };
}

function putDirection(packet: PacketWriter, yaw: number, pitch: number): void {
  const normalizedYaw = yaw < 0 ? 360 + Math.trunc(yaw) % 360 : Math.trunc(yaw) % 360;
  const direction = normalizedYaw + Math.min(180, Math.max(0, Math.trunc(pitch + 90))) * 360;
  packet.putByte(direction).putByte(direction >> 8);
}

export { gameModeName };
