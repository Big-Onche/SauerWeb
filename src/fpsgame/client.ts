import { PhysicsSimulation } from "../engine/physics";
import { ClientState, PhysicsState, type PhysicsEntity } from "../engine/physics/types";
import { copyVec3, magnitude } from "../engine/physics/vector";
import type { RegisteredMapEntity, Vec3 } from "../engine/octa";
import { EnetClient, type EnetEvent, ENET_PACKET_FLAG_UNSEQUENCED } from "../network/enet";
import { PacketReader, PacketWriter } from "../network/protocol";
import { CtfClientMode, ctfTeamFlag, type LocalCtfEvent } from "./ctf";
import { DMF, DNF, DVELF, GameModeFlag, gameModeHas, gameModeName, NetworkMessage, PROTOCOL_VERSION } from "./game";
import { WeaponSystem } from "./weapon";
import { createDamageable, hitpush, type Damageable } from "./weapon/DamageSystem";
import { Gun, WEAPONS } from "./weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponHit } from "./weapon/WeaponEvents";
import type { ConsoleLineType } from "../platform/browser/GameConsole";
import { applyNetworkPosition, createNetworkInterpolation, resetNetworkInterpolation, type NetworkInterpolation } from "./networkInterpolation";
import { FpsEntities, type EntityEffect } from "./entities";
import { GameSound } from "./sound";

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
  falling: Vec3;
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
  positionReady: boolean;
  interpolation: NetworkInterpolation;
  aiType: number;
  ownerNumber: number;
  skill: number;
}

interface CaptureBase {
  tag: number;
  ammoType: number;
  owner: string;
  enemy: string;
  converted: number;
  ammo: number;
}

export type MultiplayerEvent =
  | { type: "status"; status: string; error?: boolean }
  | { type: "map-change"; map: string; mode: number }
  | { type: "players"; disconnectedClientNumber?: number }
  | { type: "spawn"; clientNumber?: number }
  | { type: "console"; text: string; consoleType: ConsoleLineType }
  | { type: "remote-shot"; clientNumber: number; gun: Gun; from: Vec3; to: Vec3 }
  | { type: "entity-effect"; effect: EntityEffect; local: boolean }
  | { type: "playsound"; sound: GameSound; position?: Vec3 }
  | { type: "disconnect"; reason: number }
  | { type: "bot-init"; player: NetworkPlayer };

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
  readonly ctfMode = new CtfClientMode();
  readonly entities: FpsEntities;
  readonly teamScores = new Map<string, number>();
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
  private mapEntities: Array<{ index: number; type: number; typeName: string; position: Vec3; attributes: number[] }> = [];
  private loadedMapName = "";
  private loadedMapCrc = 0;
  private mapInfoPending = false;
  private captureBases: CaptureBase[] = [];
  private localGame = false;

  constructor(readonly physics: PhysicsSimulation, readonly weapons: WeaponSystem) {
    super();
    this.entities = new FpsEntities(physics, {
      effect: (effect, local) => this.emit({ type: "entity-effect", effect, local }),
      send: (effect) => this.sendEntityEffect(effect),
      warning: (message) => this.console(message, "error"),
    });
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
      this.emit({ type: "status", status: error instanceof Error ? error.message : String(error), error: true });
      throw error;
    }
  }

  // Original: src/fpsgame/server.cpp, localconnect() / localclienttoserver().
  // Vanilla bot matches still have a local client. Preserving that invariant lets the normal HUD,
  // scoreboard, spectator and client-mode code serve both local and remote games.
  startLocalGame(playerName: string, playerModel = 0): void {
    this.disconnect();
    this.localGame = true;
    this.clientNumber = 0;
    this.endpoint = { host: "local", port: 0, playerName: playerName.slice(0, 15) || "unnamed", playerModel };
    this.serverDescription = "local bot match";
    this.mapStarted = performance.now();
    this.timeLeftSeconds = 10 * 60;
    const player = this.playerFor(this.clientNumber);
    Object.assign(player, { name: this.endpoint.playerName, model: playerModel, state: ClientState.Alive, alive: true });
    this.copyLocalSpawnState(player);
    this.synchronizeLocalState();
    this.emit({ type: "players" });
    this.emit({ type: "spawn", clientNumber: this.clientNumber });
  }

  disconnect(): void {
    this.transport.close();
    this.connected = false;
    this.localGame = false;
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
    this.entities.checkitems(nowMilliseconds);
    if (this.localGame) {
      this.syncLocalPlayer();
      this.timeLeftSeconds = Math.max(0, 10 * 60 - Math.trunc((nowMilliseconds - this.mapStarted) / 1000));
      if (gameModeHas(this.gameMode, GameModeFlag.Ctf)) {
        for (const player of this.players.values()) {
          if (player.state !== ClientState.Alive) continue;
          const feet = { ...player.position, z: player.position.z - player.eyeHeight };
          this.ctfMode.checkItems(player, feet, this.gameMode, (flag, version) => {
            if (this.ctfMode.takeFlagLocal(player, flag, version, this.gameMode,
              (event) => this.announceLocalFlag(player, event))) this.emit({ type: "players" });
          });
        }
      }
      return;
    }
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
      const items = new PacketWriter();
      if (!gameModeHas(this.gameMode, GameModeFlag.NoItems)) {
        items.putInt(NetworkMessage.ItemList);
        for (const entity of this.mapEntities) {
          if (entity.type < 8 || entity.type > 18) continue;
          items.putInt(entity.index).putInt(entity.type);
        }
        items.putInt(-1);
      }
      if (gameModeHas(this.gameMode, GameModeFlag.Ctf)) this.ctfMode.putInitFlags(items, this.gameMode);
      if (gameModeHas(this.gameMode, GameModeFlag.Capture)) {
        const bases = this.mapEntities.filter((entity) => entity.typeName === "base");
        items.putInt(NetworkMessage.Bases).putInt(bases.length);
        for (const base of bases) {
          items.putInt(base.attributes[0] ?? 0).putInt(Math.trunc(base.position.x * DMF)).putInt(Math.trunc(base.position.y * DMF))
            .putInt(Math.trunc(base.position.z * DMF));
        }
      }
      const itemBytes = items.finish();
      if (itemBytes.length) this.transport.send(1, itemBytes, true);
      this.mapInfoPending = false;
    }
    if (!this.isSpectator && !this.physics.player.alive && (this.respawnRequested || this.weapons.controller.attacking) &&
        nowMilliseconds - this.lastSpawnAttempt >= 1000) {
      this.transport.send(1, new PacketWriter().putInt(NetworkMessage.TrySpawn).finish(), true);
      this.lastSpawnAttempt = nowMilliseconds;
    }
    if (this.physics.player.alive && gameModeHas(this.gameMode, GameModeFlag.Ctf)) {
      const feet = { ...this.physics.player.position, z: this.physics.player.position.z - this.physics.player.eyeHeight };
      this.ctfMode.checkItems(this.players.get(this.clientNumber), feet, this.gameMode, (flag, version) => {
        this.transport.send(1, new PacketWriter().putInt(NetworkMessage.TakeFlag).putInt(flag).putInt(version).finish(), true);
      });
    }
    const bytes = messages.finish();
    if (bytes.length) this.transport.send(1, bytes);
    this.transport.flush();
  }

  get scoreboard(): readonly NetworkPlayer[] {
    return [...this.players.values()].sort((left, right) => {
      if (left.state === ClientState.Spectator || right.state === ClientState.Spectator) {
        if (left.state !== right.state) return left.state === ClientState.Spectator ? 1 : -1;
      }
      return gameModeHas(this.gameMode, GameModeFlag.Ctf) && right.flags !== left.flags ? right.flags - left.flags
        : right.frags - left.frags || left.name.localeCompare(right.name);
    });
  }

  get isSpectator(): boolean {
    return this.players.get(this.clientNumber)?.state === ClientState.Spectator;
  }

  get isLocalGame(): boolean { return this.localGame; }

  getTeamScore(team: string): number {
    if (gameModeHas(this.gameMode, GameModeFlag.Ctf)) return this.ctfMode.scores[ctfTeamFlag(team) - 1] ?? 0;
    return this.teamScores.get(team) ?? 0;
  }

  sendChat(text: string, team = false): void {
    const message = text.trim();
    if ((!this.connected && !this.localGame) || !message) return;
    const player = this.players.get(this.clientNumber);
    this.console(`${team ? "[team] " : ""}${this.displayName(player)}: ${message}`, team ? "team-chat" : "chat");
    if (this.localGame) return;
    this.transport.send(1, new PacketWriter().putInt(team ? NetworkMessage.SayTeam : NetworkMessage.Text).putString(message).finish(), true);
    this.transport.flush();
  }

  // Native bot administration messages from ai.cpp.
  addBot(skill = -1): void {
    if (!this.connected) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.AddBot).putInt(skill > 0 ? Math.min(101, Math.max(1, skill)) : -1).finish(), true);
  }

  deleteBot(): void { this.sendSimpleBotCommand(NetworkMessage.DeleteBot); }

  setBotLimit(limit: number): void {
    if (!this.connected) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.BotLimit).putInt(Math.min(32, Math.max(0, Math.trunc(limit)))).finish(), true);
  }

  setBotBalance(enabled: boolean): void {
    if (!this.connected) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.BotBalance).putInt(enabled ? 1 : 0).finish(), true);
  }

  syncLocalBot(bot: PhysicsEntity & { clientNumber: number; ownerNumber: number; skill: number; name: string; team: string; model: number;
    lifeSequence: number; frags: number; deaths: number; flags: number; selectedGun: number; ammo: Int32Array; lastAction: number; gunWait: number;
    lastAttackGun: number; lastPain: number; deadAt: number }): void {
    const player = this.playerFor(bot.clientNumber);
    Object.assign(player, {
      ownerNumber: bot.ownerNumber, aiType: 1, skill: bot.skill, name: bot.name, team: bot.team, model: bot.model % 5,
      lifeSequence: bot.lifeSequence, frags: bot.frags, deaths: bot.deaths, flags: bot.flags, selectedGun: bot.selectedGun, ammo: bot.ammo,
      lastAction: bot.lastAction, gunWait: bot.gunWait, lastAttackGun: bot.lastAttackGun, lastPain: bot.lastPain, deadAt: bot.deadAt,
      position: copyVec3(bot.position), velocity: copyVec3(bot.velocity), yaw: bot.yaw, pitch: bot.pitch, roll: bot.roll, move: bot.move,
      strafe: bot.strafe, physicsState: bot.physicsState, state: bot.clientState, alive: bot.alive, health: bot.health,
      maxHealth: bot.maxHealth, armour: bot.armour, armourType: bot.armourType,
    });
  }

  clearLocalBots(): void {
    for (const [clientNumber, player] of this.players) if (player.aiType !== 0 && player.ownerNumber < 0) this.players.delete(clientNumber);
    this.syncTargets();
  }

  notifyLocalStateChange(): void { this.emit({ type: "players" }); }

  localDied(victimNumber: number, actorNumber: number): void {
    if (!this.localGame) return;
    const victim = this.players.get(victimNumber), actor = this.players.get(actorNumber);
    if (!victim || !actor || victim.state === ClientState.Dead) return;
    victim.deaths++;
    if (actor === victim || actor.team && actor.team === victim.team) actor.frags--;
    else actor.frags++;
    victim.state = ClientState.Dead;
    victim.alive = false;
    victim.deadAt = performance.now();
    this.dropLocalFlags(victim);
    this.emit({ type: "playsound", sound: GameSound.Die1 + Math.floor(Math.random() * 2),
      position: victimNumber === this.clientNumber ? undefined : victim.position });
    const victimName = this.displayName(victim, "you"), actorName = this.displayName(actor, "you");
    this.console(actor === victim ? `${victimName} suicided!` : `${actorName} fragged ${victimName}`,
      victimNumber === this.clientNumber || actorNumber === this.clientNumber ? "frag-self" : "frag-other");
    if (victimNumber === this.clientNumber) {
      this.physics.player.alive = false;
      this.physics.player.clientState = ClientState.Dead;
      this.weapons.controller.setAttacking(false);
    }
    this.emit({ type: "players" });
  }

  sendOwnedBotPosition(bot: PhysicsEntity, clientNumber: number, lifeSequence: number): void {
    if (!this.connected) return;
    this.transport.send(0, this.buildPosition(bot, clientNumber, lifeSequence));
  }

  sendOwnedBotEvent(clientNumber: number, event: WeaponEvent): void {
    if (!this.connected || event.type !== "shot") return;
    const local = this.players.get(this.clientNumber);
    const normalized = { ...event, hits: event.hits.map((hit) => hit.target === this.physics.player && local
      ? { ...hit, target: Object.assign({ ...this.physics.player }, { id: `client:${this.clientNumber}`, clientNumber: this.clientNumber,
        lifeSequence: local.lifeSequence }) as unknown as NetworkPlayer }
      : hit) };
    const packet = new PacketWriter().putInt(NetworkMessage.FromAi).putInt(clientNumber)
      .putBytes(serializeShoot(normalized, Math.trunc(event.millis - this.mapStarted)));
    this.transport.send(1, packet.finish(), true);
  }

  requestOwnedBotSpawn(clientNumber: number): void {
    if (!this.connected) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.FromAi).putInt(clientNumber).putInt(NetworkMessage.TrySpawn).finish(), true);
  }

  // Original: src/fpsgame/fps.cpp
  // Function: respawn() / respawnself()
  // Sauerbraten reference: SVN r6488
  requestRespawn(): boolean {
    if (this.localGame) {
      if (this.physics.player.alive || this.isSpectator) return false;
      this.spawnLocalPlayer();
      return true;
    }
    if (!this.connected || this.physics.player.alive || this.isSpectator) return false;
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
    if (this.localGame) this.mapName = name;
  }

  setMapEntities(entities: readonly RegisteredMapEntity[]): void {
    this.mapEntities = entities.map((entity) => ({ ...entity, position: { ...entity.position }, attributes: [...entity.attributes] }));
    this.ctfMode.setup(entities, this.gameMode);
    this.entities.setMap(entities);
  }

  synchronizeLocalState(): void {
    this.syncLocalState();
  }

  synchronizeLocalSpawnState(): void {
    this.syncLocalState(true);
  }

  setLocalTeam(team: string): void {
    if (!this.localGame) return;
    const player = this.players.get(this.clientNumber);
    if (!player) return;
    player.team = team;
    Object.assign(this.physics.player, { team });
    this.emit({ type: "players" });
  }

  switchTeam(): void {
    if (this.localGame) {
      const player = this.players.get(this.clientNumber);
      if (!player || !gameModeHas(this.gameMode, GameModeFlag.Team)) return;
      this.dropLocalFlags(player);
      player.team = player.team === "good" ? "evil" : "good";
      Object.assign(this.physics.player, { team: player.team });
      this.emit({ type: "players" });
      return;
    }
    if (!this.connected) return;
    const player = this.players.get(this.clientNumber);
    const team = player?.team === "good" ? "evil" : "good";
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.SwitchTeam).putString(team).finish(), true);
    this.transport.flush();
  }

  // Original: src/fpsgame/client.cpp, togglespectator(). The server remains authoritative and may reject this request.
  setSpectator(spectating: boolean): boolean {
    if (this.localGame) {
      if (this.isSpectator === spectating) return false;
      const player = this.players.get(this.clientNumber);
      if (player) this.dropLocalFlags(player);
      this.setSpectatorState(this.clientNumber, spectating);
      if (!spectating) this.spawnLocalPlayer();
      return true;
    }
    if (!this.connected || this.clientNumber < 0 || this.isSpectator === spectating) return false;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.Spectator).putInt(this.clientNumber).putInt(spectating ? 1 : 0).finish(), true);
    this.transport.flush();
    return true;
  }

  tryDropFlag(): void {
    if (this.localGame) {
      const player = this.players.get(this.clientNumber);
      if (!this.isSpectator && player && gameModeHas(this.gameMode, GameModeFlag.Ctf) && this.dropLocalFlags(player)) {
        this.emit({ type: "players" });
      }
      return;
    }
    if (!this.connected || this.isSpectator || !gameModeHas(this.gameMode, GameModeFlag.Ctf)) return;
    if (!this.ctfMode.flags.some((flag) => flag.owner === this.clientNumber)) return;
    this.transport.send(1, new PacketWriter().putInt(NetworkMessage.TryDropFlag).finish(), true);
    this.transport.flush();
  }

  private handleEnet(event: EnetEvent): void {
    if (event.type === "connect") {
      this.emit({ type: "status", status: "ENet connected; waiting for server" });
      this.console("connected to server");
      return;
    }
    if (event.type === "disconnect") {
      this.connected = false;
      this.weapons.controller.serverAuthoritative = false;
      this.console(`server network error, disconnecting (${event.data})`, "error");
      this.emit({ type: "disconnect", reason: event.data });
      return;
    }
    if (event.type !== "receive") return;
    if (event.flags & ENET_PACKET_FLAG_UNSEQUENCED) return;
    try {
      if (event.channel === 0) this.parsePositions(new PacketReader(event.data));
      else if (event.channel === 1) this.parseMessages(-1, new PacketReader(event.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "status", status: message, error: true });
    }
  }

  private parsePositions(packet: PacketReader): void {
    while (packet.remaining) {
      const type = packet.getInt();
      if (type === NetworkMessage.DemoPacket) continue;
      if (type === NetworkMessage.Teleport) {
        const clientNumber = packet.getInt(), teleport = packet.getInt(), teledest = packet.getInt();
        const player = this.players.get(clientNumber);
        if (player && player.lifeSequence >= 0 && player.state !== ClientState.Dead) {
          this.entities.teleporteffects(teleport, teledest, false);
        }
        continue;
      }
      if (type === NetworkMessage.JumpPad) {
        const clientNumber = packet.getInt(), jumppad = packet.getInt();
        const player = this.players.get(clientNumber);
        if (player && player.lifeSequence >= 0 && player.state !== ClientState.Dead) this.entities.jumppadeffects(jumppad, false);
        continue;
      }
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
      let falling = { x: 0, y: 0, z: 0 };
      if (flags & (1 << 4)) {
        let fallingSpeed = packet.getByte();
        if (flags & (1 << 5)) fallingSpeed |= packet.getByte() << 8;
        if (flags & (1 << 6)) {
          const fallingDirection = packet.getByte() | (packet.getByte() << 8);
          falling = directionVector(fallingDirection % 360,
            Math.min(180, Math.max(0, Math.trunc(fallingDirection / 360))) - 90, fallingSpeed / DVELF);
        } else falling.z = -fallingSpeed / DVELF;
      }
      const player = this.players.get(clientNumber);
      const wrongLifeSequence = ((physicalState >> 3) & 1) !== ((player?.lifeSequence ?? 0) & 1);
      if (!player || player.lifeSequence < 0 || wrongLifeSequence || player.state === ClientState.Dead) continue;
      applyNetworkPosition(player, { ...position, z: position.z + player.eyeHeight }, yaw, pitch, roll, performance.now(),
        player.state !== ClientState.Spawning);
      player.positionReady = true;
      player.velocity = velocity;
      player.falling = falling;
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
        case NetworkMessage.MapChange: {
          this.mapName = packet.getString();
          this.gameMode = packet.getInt();
          packet.getInt();
          const mapAlreadyLoaded = this.loadedMapName.toLocaleLowerCase() === this.mapName.toLocaleLowerCase();
          this.mapInfoPending = mapAlreadyLoaded;
          this.mapStarted = performance.now();
          this.teamScores.clear();
          this.ctfMode.reset();
          if (mapAlreadyLoaded) this.ctfMode.setup(this.mapEntities, this.gameMode);
          this.captureBases = [];
          this.console(`game mode is ${gameModeName(this.gameMode)}`, "game-info");
          this.emit({ type: "map-change", map: this.mapName, mode: this.gameMode });
          break;
        }
        case NetworkMessage.InitClient: this.parseInitClient(packet); break;
        case NetworkMessage.InitAi: this.parseInitAi(packet); break;
        case NetworkMessage.ClientDisconnect: {
          const clientNumber = packet.getInt(), player = this.players.get(clientNumber);
          if (player) this.console(`leave: ${this.displayName(player)}`);
          this.players.delete(clientNumber);
          this.syncTargets();
          this.emit({ type: "players", disconnectedClientNumber: clientNumber });
          break;
        }
        case NetworkMessage.SpawnState: this.parseSpawnState(packet); break;
        case NetworkMessage.Spawn: {
          const player = this.players.get(sender);
          this.parseState(player, packet);
          if (player) {
            player.state = ClientState.Spawning;
            player.alive = false;
            player.positionReady = false;
            resetNetworkInterpolation(player);
          }
          break;
        }
        case NetworkMessage.ForceDeath: this.setDead(packet.getInt(), false); break;
        case NetworkMessage.Shoot: this.parseShoot(sender, packet); break;
        case NetworkMessage.ShotEffects: this.parseShotEffects(packet); break;
        case NetworkMessage.ExplodeEffects: {
          const clientNumber = packet.getInt(), gun = packet.getInt() as Gun;
          packet.getInt();
          const player = this.players.get(clientNumber);
          this.emit({ type: "playsound", sound: gun === Gun.Grenade ? GameSound.FireballExplode : GameSound.RocketHit,
            position: clientNumber === this.clientNumber ? undefined : player?.position });
          break;
        }
        case NetworkMessage.Damage: this.parseDamage(packet); break;
        case NetworkMessage.HitPush: this.parseHitPush(packet); break;
        case NetworkMessage.Died: this.parseDied(packet); break;
        case NetworkMessage.Text: this.parseText(sender, packet, false); break;
        case NetworkMessage.SayTeam: this.parseText(packet.getInt(), packet, true); break;
        case NetworkMessage.Resume: this.parseResume(packet); break;
        case NetworkMessage.TeamInfo: this.parseTeamInfo(packet); break;
        case NetworkMessage.ItemList: while (packet.getInt() >= 0) packet.getInt(); break;
        case NetworkMessage.ItemSpawn: {
          const entity = this.mapEntities[packet.getInt()];
          if (entity) this.emit({ type: "playsound", sound: GameSound.ItemSpawn, position: entity.position });
          break;
        }
        case NetworkMessage.ItemAccept: this.parseItemAccept(packet); break;
        case NetworkMessage.CurrentMaster:
          packet.getInt();
          for (let clientNumber = packet.getInt(); clientNumber >= 0; clientNumber = packet.getInt()) packet.getInt();
          break;
        case NetworkMessage.Pong: packet.getInt(); break;
        case NetworkMessage.TimeUp: {
          this.timeLeftSeconds = packet.getInt();
          if (this.timeLeftSeconds <= 0) this.logIntermission();
          break;
        }
        case NetworkMessage.ServerMessage: this.console(packet.getString()); break;
        case NetworkMessage.Sound: {
          const sound = packet.getInt() as GameSound, player = this.players.get(sender);
          this.emit({ type: "playsound", sound, position: sender === this.clientNumber ? undefined : player?.position });
          break;
        }
        case NetworkMessage.GunSelect: {
          const player = this.players.get(sender), gun = packet.getInt();
          if (player) {
            player.selectedGun = gun;
            this.emit({ type: "playsound", sound: GameSound.WeaponLoad, position: sender === this.clientNumber ? undefined : player.position });
          }
          break;
        }
        case NetworkMessage.ReplenishAmmo: this.parseReplenishAmmo(packet); break;
        case NetworkMessage.BaseRegen: this.parseBaseRegen(packet); break;
        case NetworkMessage.Bases: this.parseBases(packet); break;
        case NetworkMessage.BaseInfo: this.parseBaseInfo(packet); break;
        case NetworkMessage.BaseScore: this.parseBaseScore(packet); break;
        case NetworkMessage.Announce: {
          const item = packet.getInt();
          if (item === 18) {
            this.console("quad damage will spawn in 10 seconds!", "game-info");
            this.emit({ type: "playsound", sound: GameSound.VoiceQuad10 });
          } else if (item === 15) {
            this.console("health boost will spawn in 10 seconds!", "game-info");
            this.emit({ type: "playsound", sound: GameSound.VoiceBoost10 });
          }
          break;
        }
        case NetworkMessage.InitFlags: this.ctfMode.parseInitFlags(packet, this.gameMode); this.emit({ type: "players" }); break;
        case NetworkMessage.DropFlag: this.parseDropFlag(packet); break;
        case NetworkMessage.TakeFlag: this.parseTakeFlag(packet); break;
        case NetworkMessage.ReturnFlag: this.parseReturnFlag(packet); break;
        case NetworkMessage.ResetFlag: this.parseResetFlag(packet); break;
        case NetworkMessage.InvisibleFlag: this.ctfMode.setInvisible(packet.getInt(), packet.getInt() > 0); break;
        case NetworkMessage.ScoreFlag: this.parseScoreFlag(packet); break;
        case NetworkMessage.ClientPing: {
          const player = this.players.get(sender), ping = packet.getInt();
          if (player) player.ping = ping;
          break;
        }
        case NetworkMessage.SwitchName: {
          const player = this.players.get(sender), name = packet.getString();
          if (player) { this.console(`${this.displayName(player)} is now known as ${name}`); player.name = name; }
          break;
        }
        case NetworkMessage.SwitchModel: {
          const player = this.players.get(sender), model = packet.getInt();
          if (player) player.model = model;
          break;
        }
        case NetworkMessage.SetTeam: {
          const player = this.playerFor(packet.getInt()), team = packet.getString();
          const reason = packet.getInt();
          if (reason >= 0) this.console(`${this.displayName(player)} ${reason === 1 ? "was forced" : "switched"} to team ${team}`);
          player.team = team;
          this.emit({ type: "players" }); break;
        }
        case NetworkMessage.PauseGame: packet.getInt(); packet.getInt(); break;
        case NetworkMessage.GameSpeed: packet.getInt(); packet.getInt(); break;
        case NetworkMessage.Spectator: {
          this.setSpectatorState(packet.getInt(), packet.getInt() !== 0);
          break;
        }
        case NetworkMessage.EditEntity:
          for (let field = 0; field < 10; field++) packet.getInt();
          break;
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
    this.console(`join: ${this.displayName(player)}`);
    this.emit({ type: "players" });
  }

  private parseSpawnState(packet: PacketReader): void {
    const clientNumber = packet.getInt(), player = this.playerFor(clientNumber);
    this.parseState(player, packet);
    player.state = ClientState.Alive;
    player.alive = true;
    player.positionReady = clientNumber === this.clientNumber;
    player.deadAt = 0;
    if (clientNumber === this.clientNumber) {
      this.respawnRequested = false;
      this.syncLocalState(true);
    }
    const confirmation = new PacketWriter();
    if (clientNumber !== this.clientNumber) confirmation.putInt(NetworkMessage.FromAi).putInt(clientNumber);
    confirmation.putInt(NetworkMessage.Spawn).putInt(player.lifeSequence).putInt(player.selectedGun);
    this.transport.send(1, confirmation.finish(), true);
    this.transport.flush();
    this.emit({ type: "spawn", clientNumber });
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
    this.syncLocalState();
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
    this.weapons.events.emit({ type: "shot-effect", gun, from, to, rays: [], clientNumber });
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
    this.weapons.events.emit({ type: "shot-effect", gun, from, to, rays: [], clientNumber: sender });
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
    if (targetNumber === this.clientNumber && !this.isSpectator) {
      this.physics.player.armour = armour;
      this.physics.player.health = health;
    }
    if (health > 0) this.emit({ type: "playsound", sound: targetNumber === this.clientNumber ? GameSound.Pain6
      : GameSound.Pain1 + Math.floor(Math.random() * 5), position: targetNumber === this.clientNumber ? undefined : target.position });
    this.emit({ type: "players" });
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_HITPUSH
  // Sauerbraten reference: SVN r6488
  private parseHitPush(packet: PacketReader): void {
    const targetNumber = packet.getInt(), gun = packet.getInt() as Gun, damage = packet.getInt();
    const direction = { x: packet.getInt() / DNF, y: packet.getInt() / DNF, z: packet.getInt() / DNF };
    const target = this.players.get(targetNumber);
    if (target) hitpush(target, damage * (target.health <= 0 ? 2 : 1), direction, gun);
    if (targetNumber === this.clientNumber && !this.isSpectator) {
      hitpush(this.physics.player, damage * (this.physics.player.health <= 0 ? 2 : 1), direction, gun);
    }
    this.emit({ type: "players" });
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
    const entityType = this.mapEntities[entityIndex]?.type;
    if (!Number.isInteger(entityType) || entityType < 8 || entityType > 18) return;
    const player = this.players.get(clientNumber);
    const itemSound = entityType <= 13 ? GameSound.ItemAmmo : entityType <= 15 ? GameSound.ItemHealth
      : entityType <= 17 ? GameSound.ItemArmour : GameSound.ItemPowerup;
    this.emit({ type: "playsound", sound: itemSound, position: clientNumber === this.clientNumber ? undefined : player?.position });
    if (clientNumber === this.clientNumber && entityType === 15) this.emit({ type: "playsound", sound: GameSound.VoiceBoost });
    if (clientNumber === this.clientNumber && entityType === 18) this.emit({ type: "playsound", sound: GameSound.VoiceQuad });
    if (entityType > 13) return;
    const gun = entityType - 8 + Gun.Shotgun;
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

  // Original: src/fpsgame/capture.h, captureclientmode::initbase(), updatebase(), setscore().
  private parseBases(packet: PacketReader): void {
    const count = packet.getInt(), mapBases = this.mapEntities.filter((entity) => entity.typeName === "base");
    this.captureBases = [];
    for (let index = 0; index < count; index++) {
      const ammoType = packet.getInt(), owner = packet.getString(), enemy = packet.getString(), converted = packet.getInt(), ammo = packet.getInt();
      const tag = (mapBases[index]?.attributes[1] ?? 0) > 0 ? mapBases[index].attributes[1] : index + 1;
      this.captureBases.push({ tag, ammoType, owner, enemy, converted, ammo });
    }
  }

  private parseBaseInfo(packet: PacketReader): void {
    const index = packet.getInt(), owner = packet.getString(), enemy = packet.getString(), converted = packet.getInt(), ammo = packet.getInt();
    const base = this.captureBases[index];
    if (!base) return;
    if (owner && owner !== base.owner) {
      this.console(`${this.teamDisplay(owner)} captured base ${base.tag}`, "game-info");
      if (owner === this.players.get(this.clientNumber)?.team) this.emit({ type: "playsound", sound: GameSound.VoiceBaseCaptured });
    } else if (!owner && base.owner) {
      this.console(`${this.teamDisplay(base.owner)} lost base ${base.tag}`, "game-info");
      if (base.owner === this.players.get(this.clientNumber)?.team) this.emit({ type: "playsound", sound: GameSound.VoiceBaseLost });
    }
    Object.assign(base, { owner, enemy, converted, ammo });
    this.emit({ type: "players" });
  }

  private parseBaseScore(packet: PacketReader): void {
    packet.getInt();
    const team = packet.getString(), total = packet.getInt();
    this.teamScores.set(team, total);
    if (total >= 10_000) this.console(`${this.teamDisplay(team)} captured all bases`, "game-info");
    this.emit({ type: "players" });
  }

  // Original: src/fpsgame/client.cpp
  // Function: parsepacketclient(), N_DIED
  // Sauerbraten reference: SVN r6488
  private parseDied(packet: PacketReader): void {
    const victimNumber = packet.getInt(), victim = this.playerFor(victimNumber), actor = this.playerFor(packet.getInt());
    actor.frags = packet.getInt();
    const teamFrags = packet.getInt();
    if (actor.team) this.teamScores.set(actor.team, teamFrags);
    const victimName = this.displayName(victim, "you"), actorName = this.displayName(actor, "you");
    const involved = victimNumber === this.clientNumber || actor.clientNumber === this.clientNumber;
    if (victimNumber === actor.clientNumber) this.console(`${victimName} suicided${victimNumber === this.clientNumber ? "!" : ""}`,
      involved ? "frag-self" : "frag-other");
    else if (victim.team && victim.team === actor.team) {
      const text = actor.clientNumber === this.clientNumber ? `${actorName} fragged a teammate (${victimName})`
        : victimNumber === this.clientNumber ? `${victimName} got fragged by a teammate (${actorName})`
          : `${actorName} fragged a teammate (${victimName})`;
      this.console(text, "teamkill");
    } else this.console(victimNumber === this.clientNumber ? `${victimName} got fragged by ${actorName}` : `${actorName} fragged ${victimName}`,
      involved ? "frag-self" : "frag-other");
    this.setDead(victimNumber);
  }

  private parseText(sender: number, packet: PacketReader, team: boolean): void {
    const player = this.players.get(sender), text = packet.getString();
    if (!player) return;
    this.console(`${team ? "[team] " : ""}${this.displayName(player)}: ${text}`, team ? "team-chat" : "chat");
  }

  private setDead(clientNumber: number, countDeath = true): void {
    const player = this.playerFor(clientNumber);
    const wasDead = player.state === ClientState.Dead;
    player.state = ClientState.Dead; player.alive = false;
    resetNetworkInterpolation(player);
    if (countDeath && !wasDead) player.deaths++;
    player.deadAt = performance.now();
    if (clientNumber === this.clientNumber) {
      this.physics.player.alive = false;
      this.physics.player.clientState = ClientState.Dead;
      this.weapons.controller.setAttacking(false);
    }
    if (!wasDead) this.emit({ type: "playsound", sound: GameSound.Die1 + Math.floor(Math.random() * 2),
      position: clientNumber === this.clientNumber ? undefined : player.position });
    this.emit({ type: "players" });
  }

  private logIntermission(): void {
    const player = this.players.get(this.clientNumber);
    this.console("intermission:", "game-info");
    this.console("game has ended!", "game-info");
    if (!player) return;
    const objective = gameModeHas(this.gameMode, GameModeFlag.Ctf) ? `, flags: ${player.flags}`
      : gameModeHas(this.gameMode, GameModeFlag.Collect) ? `, skulls: ${player.flags}` : "";
    this.console(`player frags: ${player.frags}${objective}, deaths: ${player.deaths}`, "game-info");
  }

  private parseTeamInfo(packet: PacketReader): void {
    this.teamScores.clear();
    for (let team = packet.getString(); team; team = packet.getString()) this.teamScores.set(team, packet.getInt());
  }

  private parseDropFlag(packet: PacketReader): void {
    const clientNumber = packet.getInt(), flag = packet.getInt(), version = packet.getInt();
    const location = { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
    const player = this.playerFor(clientNumber);
    const flagName = this.flagName(flag);
    this.ctfMode.dropFlag(flag, version, location, player.yaw);
    this.console(`${this.displayName(player)} dropped ${flagName}`, "game-info");
    this.emit({ type: "playsound", sound: GameSound.FlagDrop, position: clientNumber === this.clientNumber ? undefined : player.position });
  }

  private parseTakeFlag(packet: PacketReader): void {
    const clientNumber = packet.getInt(), flag = packet.getInt(), version = packet.getInt();
    const player = this.playerFor(clientNumber), state = this.ctfMode.flags[flag];
    const action = gameModeHas(this.gameMode, GameModeFlag.Hold) ? "picked up the flag for"
      : gameModeHas(this.gameMode, GameModeFlag.Protect) || state?.dropped ? "picked up" : "stole";
    const suffix = gameModeHas(this.gameMode, GameModeFlag.Hold) ? ` ${this.teamName(player.team)}` : ` ${this.flagName(flag)}`;
    this.ctfMode.takeFlag(clientNumber, flag, version);
    this.console(`${this.displayName(player)} ${action}${suffix}`, "game-info");
    this.emit({ type: "playsound", sound: GameSound.FlagPickup, position: clientNumber === this.clientNumber ? undefined : player.position });
  }

  private parseReturnFlag(packet: PacketReader): void {
    const clientNumber = packet.getInt(), flag = packet.getInt(), version = packet.getInt();
    const name = this.flagName(flag);
    this.ctfMode.returnFlag(flag, version);
    this.console(`${this.displayName(this.playerFor(clientNumber))} returned ${name}`, "game-info");
    const player = this.players.get(clientNumber);
    this.emit({ type: "playsound", sound: GameSound.FlagReturn, position: clientNumber === this.clientNumber ? undefined : player?.position });
  }

  private parseResetFlag(packet: PacketReader): void {
    const flag = packet.getInt(), version = packet.getInt(), spawnIndex = packet.getInt(), team = packet.getInt(), score = packet.getInt();
    const state = this.ctfMode.flags[flag], shouldLog = !gameModeHas(this.gameMode, GameModeFlag.Hold) || (state?.spawnIndex ?? -1) >= 0;
    const name = this.flagName(flag);
    this.ctfMode.resetFlag(flag, version, spawnIndex, team, score, this.gameMode);
    if (shouldLog) this.console(`${name} reset`, "game-info");
    if (shouldLog) this.emit({ type: "playsound", sound: GameSound.FlagReset });
    this.emit({ type: "players" });
  }

  private parseScoreFlag(packet: PacketReader): void {
    const clientNumber = packet.getInt(), relay = packet.getInt(), relayVersion = packet.getInt(), goal = packet.getInt(),
      goalVersion = packet.getInt(), goalSpawn = packet.getInt(), team = packet.getInt(), score = packet.getInt(), flags = packet.getInt();
    const player = this.playerFor(clientNumber);
    this.ctfMode.scoreFlag(player, relay, relayVersion, goal, goalVersion, goalSpawn, team, score, flags, this.gameMode);
    const localTeam = ctfTeamFlag(this.players.get(this.clientNumber)?.team ?? "");
    this.console(`${this.displayName(player)} scored for ${team === localTeam ? "your team" : "the enemy team"}`, "game-info");
    this.emit({ type: "playsound", sound: team === localTeam ? GameSound.FlagScore : GameSound.FlagFail });
    if (score >= 10) this.console(`${team === localTeam ? "your team" : "the enemy team"} captured ${score} flags`, "game-info");
    this.emit({ type: "players" });
  }

  private buildPosition(player: PhysicsEntity = this.physics.player, clientNumber = this.clientNumber,
                        lifeSequence = this.playerFor(clientNumber).lifeSequence): Uint8Array {
    const packet = new PacketWriter().putInt(NetworkMessage.Pos).putUInt(clientNumber);
    const physicalState = player.physicsState | ((lifeSequence & 1) << 3) | ((player.move & 3) << 4) |
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

  private sendEntityEffect(effect: EntityEffect): void {
    if (!this.connected || this.clientNumber < 0) return;
    this.transport.send(0, this.buildPosition());
    const packet = new PacketWriter().putInt(effect.type === "teleport" ? NetworkMessage.Teleport : NetworkMessage.JumpPad)
      .putInt(this.clientNumber);
    if (effect.type === "teleport") packet.putInt(effect.teleport).putInt(effect.teledest);
    else packet.putInt(effect.jumppad);
    this.transport.send(0, packet.finish(), true);
    this.transport.flush();
  }

  private handleWeaponEvent(event: WeaponEvent): void {
    if (!this.connected || this.isSpectator) return;
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
      lifeSequence: -1, state: ClientState.Dead, frags: 0, deaths: 0, flags: 0, ping: 0, yaw: 0, pitch: 0, roll: 0,
      falling: { x: 0, y: 0, z: 0 }, move: 0 as const,
      strafe: 0 as const, physicsState: PhysicsState.Fall, selectedGun: Gun.Pistol, ammo: new Int32Array(12),
      lastAction: 0, gunWait: 0, lastAttackGun: -1, lastPain: 0, deadAt: 0,
      positionReady: false,
      interpolation: createNetworkInterpolation(this.physics.player.position),
      aiType: 0, ownerNumber: -1, skill: 0,
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

  private parseInitAi(packet: PacketReader): void {
    const clientNumber = packet.getInt(), ownerNumber = packet.getInt(), aiType = packet.getInt(), skill = Math.min(101, Math.max(1, packet.getInt())),
      model = packet.getInt(), name = packet.getString(16), team = packet.getString(5), player = this.playerFor(clientNumber);
    Object.assign(player, { ownerNumber, aiType, skill, model: ((model % 5) + 5) % 5, name: name || "bot", team });
    this.console(`join: ${this.displayName(player)}`);
    this.emit({ type: "bot-init", player });
    this.emit({ type: "players" });
  }

  private sendSimpleBotCommand(type: NetworkMessage): void {
    if (!this.connected) return;
    this.transport.send(1, new PacketWriter().putInt(type).finish(), true);
  }

  private emit(detail: MultiplayerEvent): void { this.dispatchEvent(new CustomEvent<MultiplayerEvent>("multiplayer", { detail })); }

  private console(text: string, consoleType: ConsoleLineType = "info"): void { this.emit({ type: "console", text, consoleType }); }

  private dropLocalFlags(player: NetworkPlayer): boolean {
    const position = player.clientNumber === this.clientNumber ? this.physics.player.position : player.position;
    const yaw = player.clientNumber === this.clientNumber ? this.physics.player.yaw : player.yaw;
    return this.ctfMode.dropFlags(player.clientNumber, position, yaw,
      (event) => this.announceLocalFlag(player, event));
  }

  // Original: src/fpsgame/ctf.h, ctfclientmode flag event console output.
  private announceLocalFlag(player: NetworkPlayer, event: LocalCtfEvent): void {
    const name = this.displayName(player);
    const position = player.clientNumber === this.clientNumber ? undefined : player.position;
    if (event.type === "drop") {
      this.console(`${name} dropped ${this.flagName(event.flag.id)}`, "game-info");
      this.emit({ type: "playsound", sound: GameSound.FlagDrop, position });
    } else if (event.type === "return") {
      this.console(`${name} returned ${this.flagName(event.flag.id)}`, "game-info");
      this.emit({ type: "playsound", sound: GameSound.FlagReturn, position });
    }
    else if (event.type === "take") {
      const action = gameModeHas(this.gameMode, GameModeFlag.Hold) ? "picked up the flag for"
        : gameModeHas(this.gameMode, GameModeFlag.Protect) || event.wasDropped ? "picked up" : "stole";
      const suffix = gameModeHas(this.gameMode, GameModeFlag.Hold) ? ` ${this.teamName(player.team)}`
        : ` ${this.flagName(event.flag.id)}`;
      this.console(`${name} ${action}${suffix}`, "game-info");
      this.emit({ type: "playsound", sound: GameSound.FlagPickup, position });
    } else {
      const localTeam = ctfTeamFlag(this.players.get(this.clientNumber)?.team ?? ""), team = ctfTeamFlag(player.team);
      const teamName = team === localTeam ? "your team" : "the enemy team", score = this.ctfMode.scores[team - 1] ?? 0;
      this.console(`${name} scored for ${teamName}`, "game-info");
      this.emit({ type: "playsound", sound: team === localTeam ? GameSound.FlagScore : GameSound.FlagFail });
      if (score >= 10) this.console(`${teamName} captured ${score} flags`, "game-info");
    }
  }

  private displayName(player: NetworkPlayer | undefined, localName = "you"): string {
    return player?.clientNumber === this.clientNumber ? localName : player?.name || "unnamed";
  }

  private teamName(team: string): string {
    return team === this.players.get(this.clientNumber)?.team ? "your team" : "the enemy team";
  }

  private teamDisplay(team: string): string {
    return team === this.players.get(this.clientNumber)?.team ? "your team" : team;
  }

  private flagName(id: number): string {
    if (gameModeHas(this.gameMode, GameModeFlag.Hold)) return "the flag";
    const flag = this.ctfMode.flags[id], localTeam = ctfTeamFlag(this.players.get(this.clientNumber)?.team ?? "");
    return flag?.team === localTeam ? "your flag" : "the enemy flag";
  }

  private weaponDelay(gun: number): number {
    return gun >= Gun.Fist && gun <= Gun.Pistol ? WEAPONS[gun].attackDelay : 0;
  }

  private setSpectatorState(clientNumber: number, spectating: boolean): void {
    const player = this.playerFor(clientNumber);
    player.state = spectating ? ClientState.Spectator : ClientState.Dead;
    player.alive = false;
    resetNetworkInterpolation(player);
    if (clientNumber === this.clientNumber) {
      this.respawnRequested = false;
      this.physics.player.alive = false;
      this.physics.player.clientState = player.state;
      this.weapons.controller.setAttacking(false);
    }
    this.emit({ type: "players" });
  }

  private syncLocalState(synchronizeSpawnState = false): void {
    const player = this.players.get(this.clientNumber);
    if (!player) return;
    this.physics.player.clientState = player.state;
    this.physics.player.alive = player.state === ClientState.Alive;
    if (player.state !== ClientState.Alive) this.weapons.controller.setAttacking(false);
    if (!synchronizeSpawnState) return;
    this.physics.player.health = player.health;
    this.physics.player.maxHealth = player.maxHealth;
    this.physics.player.armour = player.armour;
    this.physics.player.armourType = player.armourType;
    this.weapons.controller.respawn(performance.now());
    this.weapons.controller.inventory.selectedGun = player.selectedGun;
    this.weapons.controller.inventory.ammo.set(player.ammo);
  }

  private spawnLocalPlayer(): void {
    const player = this.players.get(this.clientNumber);
    if (!player) return;
    this.weapons.controller.spawnForGameMode(this.gameMode, performance.now());
    player.state = ClientState.Alive;
    player.alive = true;
    player.positionReady = true;
    player.lifeSequence++;
    this.physics.player.clientState = ClientState.Alive;
    this.physics.player.alive = true;
    this.copyLocalSpawnState(player);
    this.emit({ type: "spawn", clientNumber: this.clientNumber });
  }

  private copyLocalSpawnState(player: NetworkPlayer): void {
    Object.assign(player, {
      health: this.physics.player.health, maxHealth: this.physics.player.maxHealth, armour: this.physics.player.armour,
      armourType: this.physics.player.armourType, selectedGun: this.weapons.controller.inventory.selectedGun,
      ammo: new Int32Array(this.weapons.controller.inventory.ammo),
    });
  }

  private syncLocalPlayer(): void {
    const player = this.players.get(this.clientNumber);
    if (!player) return;
    if (player.state !== ClientState.Spectator && this.physics.player.clientState === ClientState.Dead && player.state !== ClientState.Dead) {
      this.localDied(this.clientNumber, this.clientNumber);
    }
    const state = player.state === ClientState.Spectator ? ClientState.Spectator : this.physics.player.clientState;
    Object.assign(player, {
      position: copyVec3(this.physics.player.position), velocity: copyVec3(this.physics.player.velocity), yaw: this.physics.player.yaw,
      pitch: this.physics.player.pitch, roll: this.physics.player.roll, move: this.physics.player.move, strafe: this.physics.player.strafe,
      physicsState: this.physics.player.physicsState, state, alive: state === ClientState.Alive, health: this.physics.player.health,
      maxHealth: this.physics.player.maxHealth, armour: this.physics.player.armour, armourType: this.physics.player.armourType,
      selectedGun: this.weapons.controller.inventory.selectedGun, ammo: this.weapons.controller.inventory.ammo,
      lastAction: this.weapons.controller.lastAction, gunWait: this.weapons.controller.gunWait,
      lastAttackGun: this.weapons.controller.lastAttackGun,
    });
  }
}

// Original: src/fpsgame/weapon.cpp
// Function: shoot(), addmsg(N_SHOOT, "rci2i6iv", ...)
// Sauerbraten reference: SVN r6488
export function serializeShoot(event: Extract<WeaponEvent, { type: "shot" }>, shotMillis: number): Uint8Array {
  const packet = new PacketWriter().putInt(NetworkMessage.Shoot).putInt(shotMillis).putInt(event.gun)
    .putInt(Math.trunc(event.from.x * DMF)).putInt(Math.trunc(event.from.y * DMF)).putInt(Math.trunc(event.from.z * DMF))
    .putInt(Math.trunc(event.to.x * DMF)).putInt(Math.trunc(event.to.y * DMF)).putInt(Math.trunc(event.to.z * DMF));
  const hits = event.hits.filter((hit): hit is WeaponHit & { target: NetworkPlayer } =>
    "clientNumber" in hit.target && "lifeSequence" in hit.target);
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
