import type { PhysicsSimulation } from "../engine/physics";
import { ClientState, PhysicsEntityType, PhysicsState, createPlayer, resetPlayer, type PhysicsEntity } from "../engine/physics/types";
import type { RegisteredMapEntity, Vec3 } from "../engine/octa";
import { copyVec3, magnitude, normalize, subtract } from "../engine/physics/vector";
import { GameModeFlag, gameModeHas } from "./game";
import { WeaponSystem } from "./weapon";
import type { Damageable } from "./weapon/DamageSystem";
import { Gun, WEAPONS } from "./weapon/WeaponDefinitions";
import type { WeaponEvent } from "./weapon/WeaponEvents";
import { JUMPMIN, SIGHTMAX, SIGHTMIN, VIEWMAX, VIEWMIN, WAYPOINTRADIUS, WaypointSystem } from "./waypoint";

export const MAXBOTS = 32;
export enum AiType { None, Bot }
export enum AiStateType { Wait, Defend, Pursue, Interest }
export enum AiTargetType { Node, Player, Affinity, Entity }

export interface AiState {
  type: AiStateType;
  millis: number;
  targetType: AiTargetType;
  target: number;
  idle: number;
  override: boolean;
}

export interface AiInfo {
  state: AiState[];
  route: number[];
  target: Vec3;
  spot: Vec3;
  enemy: number;
  enemySeen: number;
  enemyMillis: number;
  weaponPreference: Gun;
  previousNodes: number[];
  targetNode: number;
  targetLast: number;
  targetTime: number;
  targetSequence: number;
  lastRun: number;
  lastHunt: number;
  lastAction: number;
  lastCheck: number;
  jumpSeed: number;
  jumpRandom: number;
  blockTime: number;
  huntSequence: number;
  blockSequence: number;
  lastAimRandom: number;
  targetYaw: number;
  targetPitch: number;
  views: [number, number, number];
  aimRandom: Vec3;
  dontMove: boolean;
  beCareful: boolean;
}

export interface BotActor extends PhysicsEntity {
  clientNumber: number;
  ownerNumber: number;
  aiType: AiType;
  skill: number;
  name: string;
  team: string;
  model: number;
  lifeSequence: number;
  frags: number;
  deaths: number;
  flags: number;
  selectedGun: Gun;
  ammo: Int32Array;
  lastAction: number;
  gunWait: number;
  lastAttackGun: number;
  lastPain: number;
  deadAt: number;
  lastNode: number;
  respawned: number;
  ai: AiInfo;
  weaponSystem: WeaponSystem;
}

export interface BotInit {
  clientNumber: number;
  ownerNumber?: number;
  skill: number;
  name?: string;
  team?: string;
  model?: number;
}

export interface BotCallbacks {
  event?: (event: WeaponEvent, bot: BotActor) => void;
  spawnRequest?: (bot: BotActor) => void;
  changed?: () => void;
  objective?: (bot: BotActor, state: AiState, interests: AiInterest[]) => boolean;
}

export interface AiInterest {
  state: AiStateType;
  node: number;
  target: number;
  targetType: AiTargetType;
  score: number;
}

// Original: src/fpsgame/ai.cpp, ai.h and the aifind/aicheck/aidefend/aipursue hooks in capture.h, ctf.h and collect.h.
export class BotManager {
  performanceRecorder?: (phase: "ai" | "physics" | "weapons", operation: () => void) => void;
  readonly bots = new Map<number, BotActor>();
  readonly waypoints: WaypointSystem;
  aidebug = 0;
  forcegun = -1;
  private entities: readonly RegisteredMapEntity[] = [];
  private gameMode = 0;
  private lastUpdate = 0;
  private iteration = 0;
  private nextLocalClientNumber = 128;
  private random: () => number;
  private readonly itemCooldowns = new Map<string, number>();

  constructor(private readonly physics: PhysicsSimulation, private readonly localPlayer: Damageable, private readonly callbacks: BotCallbacks = {},
              random: () => number = Math.random) {
    this.random = random;
    this.waypoints = new WaypointSystem();
  }

  async setMap(mapName: string, entities: readonly RegisteredMapEntity[], gameMode: number): Promise<void> {
    this.entities = entities;
    this.gameMode = gameMode;
    this.waypoints.clearwaypoints(true);
    if (!await this.waypoints.loadwaypoints(mapName)) this.waypoints.seedwaypoints(entities);
    for (const bot of this.bots.values()) this.spawned(bot, performance.now());
  }

  setGameMode(gameMode: number): void {
    this.gameMode = gameMode;
    for (const bot of this.bots.values()) bot.weaponSystem.controller.spawnForGameMode(gameMode, performance.now());
  }

  addbot(skill = -1, team?: string): BotActor | undefined {
    if (this.bots.size >= MAXBOTS) return undefined;
    while (this.bots.has(this.nextLocalClientNumber)) this.nextLocalClientNumber++;
    return this.init({ clientNumber: this.nextLocalClientNumber++, ownerNumber: -1, skill: skill > 0 ? skill : 51 + this.rnd(50),
      name: "bot", team: team ?? this.chooseTeam(), model: this.rnd(128) });
  }

  delbot(): boolean {
    const bot = [...this.bots.values()].at(-1);
    if (!bot) return false;
    this.remove(bot.clientNumber);
    return true;
  }

  init(init: BotInit): BotActor {
    const existing = this.bots.get(init.clientNumber);
    if (existing) {
      existing.ownerNumber = init.ownerNumber ?? existing.ownerNumber;
      existing.skill = clamp(init.skill, 1, 101);
      existing.name = init.name ?? existing.name;
      existing.team = init.team ?? existing.team;
      existing.model = init.model ?? existing.model;
      existing.ai.views = [viewfieldx(existing.skill), viewfieldy(existing.skill), viewdist(existing.skill)];
      existing.weaponSystem.controller.serverAuthoritative = existing.ownerNumber >= 0;
      return existing;
    }
    const base = createPlayer(), clientNumber = init.clientNumber;
    const actor = {
      ...base,
      id: `bot:${clientNumber}`,
      entityType: PhysicsEntityType.Ai,
      clientNumber,
      ownerNumber: init.ownerNumber ?? -1,
      aiType: AiType.Bot,
      skill: clamp(init.skill, 1, 101),
      name: init.name ?? "bot",
      team: init.team ?? "",
      model: init.model ?? 0,
      lifeSequence: 0,
      frags: 0,
      deaths: 0,
      flags: 0,
      selectedGun: Gun.Pistol,
      ammo: new Int32Array(12),
      lastAction: 0,
      gunWait: 0,
      lastAttackGun: -1,
      lastPain: 0,
      deadAt: 0,
      lastNode: -1,
      respawned: -1,
      ai: createAiInfo(performance.now(), clamp(init.skill, 1, 101)),
      weaponSystem: undefined as unknown as WeaponSystem,
    } satisfies Omit<BotActor, "weaponSystem"> & { weaponSystem: WeaponSystem };
    actor.weaponSystem = new WeaponSystem({ raycast: (origin, direction, distance, radius) => this.physics.raycast(origin, direction, distance, radius) }, actor, this.random);
    actor.weaponSystem.controller.spawnForGameMode(this.gameMode);
    actor.weaponSystem.controller.serverAuthoritative = actor.ownerNumber >= 0;
    actor.ammo = actor.weaponSystem.controller.inventory.ammo;
    actor.weaponSystem.events.on((event) => this.handleWeaponEvent(actor, event));
    this.bots.set(clientNumber, actor);
    this.spawned(actor, performance.now());
    this.syncTargets();
    this.callbacks.changed?.();
    return actor;
  }

  remove(clientNumber: number): void {
    this.bots.delete(clientNumber);
    this.syncTargets();
    this.callbacks.changed?.();
  }

  clear(): void {
    this.bots.clear();
    this.syncTargets();
    this.callbacks.changed?.();
  }

  spawned(bot: BotActor, now: number): void {
    const spawn = this.chooseSpawn(bot.team);
    resetPlayer(bot, { ...spawn.position, z: spawn.position.z + bot.eyeHeight }, spawn.attributes[0] ?? 0);
    bot.lifeSequence++;
    bot.respawned = -1;
    bot.deadAt = 0;
    bot.lastNode = this.waypoints.closestwaypoint(spawn.position, SIGHTMIN, false);
    bot.ai = createAiInfo(now, bot.skill);
    bot.weaponSystem.controller.spawnForGameMode(this.gameMode, now);
    bot.ammo = bot.weaponSystem.controller.inventory.ammo;
    bot.selectedGun = bot.weaponSystem.controller.inventory.selectedGun;
    this.callbacks.changed?.();
  }

  killed(victim: BotActor, attacker?: Damageable, now = performance.now()): void {
    if (victim.clientState === ClientState.Dead) return;
    victim.alive = false;
    victim.clientState = ClientState.Dead;
    victim.deadAt = victim.lastPain = now;
    victim.deaths++;
    victim.move = victim.strafe = 0;
    if (attacker && "frags" in attacker && attacker !== victim) (attacker as BotActor).frags++;
    this.callbacks.changed?.();
  }

  damaged(victim: BotActor, attacker: Damageable, now = performance.now()): void {
    victim.lastPain = now;
    const enemy = this.actorNumber(attacker);
    if (enemy >= 0 && this.targetable(victim, attacker)) {
      victim.ai.enemy = enemy;
      victim.ai.enemyMillis = victim.ai.enemySeen = now;
    }
    for (const teammate of this.bots.values()) {
      if (teammate === victim || teammate.team !== victim.team || !teammate.alive || !this.targetable(teammate, attacker)) continue;
      if (distance(teammate.position, victim.position) > SIGHTMAX) continue;
      teammate.ai.enemy = enemy;
      teammate.ai.enemyMillis = teammate.ai.enemySeen = now;
      break;
    }
  }

  update(now: number, players: readonly Damageable[], localAlive = true): void {
    if (!this.lastUpdate) this.lastUpdate = now;
    const elapsed = Math.min(100, Math.max(0, now - this.lastUpdate));
    this.lastUpdate = now;
    const actors = [...this.bots.values()];
    if (!actors.length) return;
    const damageTargets: Damageable[] = [this.localPlayer, ...players, ...actors];
    for (const bot of actors) bot.weaponSystem.targets.splice(0, bot.weaponSystem.targets.length, ...damageTargets);
    this.iteration = (this.iteration + 1) % actors.length;
    for (let index = 0; index < actors.length; index++) {
      const bot = actors[index];
      this.profile("weapons", () => this.syncWeaponState(bot));
      if (!bot.alive) {
        if (now - bot.deadAt >= 500 && bot.respawned !== bot.lifeSequence) {
          bot.respawned = bot.lifeSequence;
          if (bot.ownerNumber >= 0) this.callbacks.spawnRequest?.(bot);
          else this.spawned(bot, now);
        }
        continue;
      }
      this.profile("ai", () => {
        this.navigate(bot);
        this.think(bot, now, index === this.iteration, players, localAlive);
      });
      this.profile("physics", () => this.physics.simulateEntity(bot, Math.max(1, elapsed)));
      this.profile("ai", () => {
        this.timeouts(bot, elapsed, now);
        this.checkItems(bot, now);
      });
      let fired = false;
      this.profile("weapons", () => { fired = bot.weaponSystem.update(now, bot.ai.target); });
      if (fired && bot.selectedGun === Gun.Pistol && bot.skill <= 100) {
        const controller = bot.weaponSystem.controller;
        controller.gunWait += Math.trunc(controller.gunWait * ((101 - bot.skill + this.rnd(111 - bot.skill)) / 100));
      }
      bot.weaponSystem.controller.setAttacking(false);
      bot.jumping = false;
      if (!bot.alive || bot.health <= 0 || bot.clientState === ClientState.Dead) this.killed(bot, undefined, now);
    }
  }

  private profile(phase: "ai" | "physics" | "weapons", operation: () => void): void {
    if (this.performanceRecorder) this.performanceRecorder(phase, operation);
    else operation();
  }

  private timeouts(bot: BotActor, elapsed: number, now: number): void {
    if (bot.blocked) {
      bot.ai.blockTime += elapsed;
      if (bot.ai.blockTime > (bot.ai.blockSequence + 1) * 1000) {
        bot.ai.blockSequence++;
        if (bot.ai.blockSequence <= 3) {
          if (this.waypoints.iswaypoint(bot.ai.targetNode)) {
            bot.ai.previousNodes.unshift(bot.ai.targetNode);
            bot.ai.previousNodes.length = Math.min(6, bot.ai.previousNodes.length);
          }
          bot.ai.route.length = 0;
        } else if (bot.ai.blockSequence >= 6) this.killed(bot, bot, now);
      }
    } else { bot.ai.blockTime = 0; bot.ai.blockSequence = 0; }
    if (bot.ai.targetNode === bot.ai.targetLast) {
      bot.ai.targetTime += elapsed;
      if (bot.ai.targetTime > (bot.ai.targetSequence + 1) * 1000) {
        bot.ai.targetSequence++;
        if (bot.ai.targetSequence <= 3) bot.ai.route.length = 0;
        else if (bot.ai.targetSequence >= 6) this.killed(bot, bot, now);
      }
    } else {
      bot.ai.targetTime = bot.ai.targetSequence = 0;
      bot.ai.targetLast = bot.ai.targetNode;
    }
  }

  private checkItems(bot: BotActor, now: number): void {
    const feet = feetPosition(bot);
    for (const entity of this.entities) {
      const radius = entity.type === 19 ? 16 : 12;
      if (distance(feet, entity.position) >= radius) continue;
      const cooldownKey = `${bot.clientNumber}:${entity.index}`;
      if (now < (this.itemCooldowns.get(cooldownKey) ?? 0)) continue;
      if (entity.type === 19) {
        const tag = entity.attributes[0] ?? 0;
        const destination = this.entities.find((candidate) => candidate.type === 20 && (candidate.attributes[1] ?? 0) === tag);
        if (!destination) continue;
        bot.yaw = destination.attributes[0] ?? bot.yaw;
        bot.velocity = { x: 0, y: 0, z: 0 };
        bot.position = { ...destination.position, z: destination.position.z + bot.eyeHeight };
        bot.previousPosition = copyVec3(bot.position);
        bot.lastNode = this.waypoints.closestwaypoint(destination.position, SIGHTMIN, false);
        this.itemCooldowns.set(cooldownKey, now + 500);
      } else if (entity.type === 23) {
        bot.falling = { x: 0, y: 0, z: 0 };
        bot.physicsState = PhysicsState.Fall;
        bot.timeInAir = 1;
        bot.velocity = { x: signedByte(entity.attributes[2] ?? 0) * 10, y: signedByte(entity.attributes[1] ?? 0) * 10,
          z: (entity.attributes[0] ?? 0) * 12.5 };
        this.itemCooldowns.set(cooldownKey, now + 300);
      } else if (!gameModeHas(this.gameMode, GameModeFlag.NoItems) && entity.type >= 8 && entity.type <= 18) {
        if (!this.pickup(bot, entity.type)) continue;
        this.itemCooldowns.set(cooldownKey, now + (entity.type === 18 ? 60_000 : 10_000));
      }
    }
  }

  private pickup(bot: BotActor, type: number): boolean {
    const inventory = bot.weaponSystem.controller.inventory;
    if (type >= 8 && type <= 13) {
      const gun = type - 7 as Gun, pickup = inventory.pickup(gun);
      if (!pickup.max || inventory.ammo[gun] >= pickup.max) return false;
      inventory.ammo[gun] = Math.min(pickup.max, inventory.ammo[gun] + pickup.add);
      return true;
    }
    if (type === 14) { if (bot.health >= bot.maxHealth) return false; bot.health = Math.min(bot.maxHealth, bot.health + 25); return true; }
    if (type === 15) { bot.maxHealth += 10; bot.health += 10; return true; }
    if (type === 16 || type === 17) {
      const armourType = type === 17 ? 2 : 1, armour = type === 17 ? 100 : 50;
      if (bot.armourType > armourType || bot.armourType === armourType && bot.armour >= armour) return false;
      bot.armourType = armourType; bot.armour = armour; return true;
    }
    if (type === 18) { bot.weaponSystem.controller.quadMilliseconds = Math.max(30_000, bot.weaponSystem.controller.quadMilliseconds + 30_000); return true; }
    return false;
  }

  private think(bot: BotActor, now: number, run: boolean, players: readonly Damageable[], localAlive: boolean): void {
    const state = bot.ai.state.at(-1) ?? this.addState(bot, AiStateType.Wait, now);
    if (run || now - bot.ai.lastCheck > 250) {
      bot.ai.lastCheck = now;
      const interests: AiInterest[] = [];
      if (!this.callbacks.objective?.(bot, state, interests)) this.find(bot, state, interests, players, localAlive);
      if (interests.length) this.parseinterests(bot, state, interests, now);
    }
    const enemy = this.findEnemy(bot, players, localAlive);
    if (enemy) this.combat(bot, enemy, now);
    else this.hunt(bot, state, now);
    bot.ai.lastRun = now;
  }

  private find(bot: BotActor, state: AiState, interests: AiInterest[], players: readonly Damageable[], localAlive: boolean): void {
    this.findObjectiveInterests(bot, interests);
    if (gameModeHas(this.gameMode, GameModeFlag.Team)) {
      const teammates: Damageable[] = [...this.bots.values(), ...players];
      if (localAlive) teammates.push(this.localPlayer);
      for (const teammate of teammates) {
        if (teammate === bot || !("team" in teammate) || teammate.team !== bot.team || !teammate.alive) continue;
        const node = this.waypoints.closestwaypoint(teammate.position, SIGHTMIN, true);
        if (!this.waypoints.iswaypoint(node)) continue;
        const target = this.actorNumber(teammate), assigned = [...this.bots.values()].filter((other) => other !== bot &&
          other.ai.state.some((candidate) => candidate.type === AiStateType.Defend && candidate.targetType === AiTargetType.Player &&
            candidate.target === target)).length;
        interests.push({ state: AiStateType.Defend, node, target, targetType: AiTargetType.Player,
          score: distance(bot.position, teammate.position) * (assigned + 1) / (this.hasGoodAmmo(bot) ? 100 : 10) });
      }
    }
    for (const entity of this.entities) {
      if (entity.type < 8 || entity.type > 18) continue;
      const node = this.waypoints.closestwaypoint(entity.position, SIGHTMIN, true);
      if (!this.waypoints.iswaypoint(node)) continue;
      const score = distance(bot.position, entity.position) / Math.max(this.itemScore(bot, entity.type), 1);
      interests.push({ state: AiStateType.Interest, node, target: entity.index, targetType: AiTargetType.Entity, score });
    }
    if (state.type === AiStateType.Wait && !interests.length) {
      const candidates = this.waypoints.findwaypointswithin(bot.position, SIGHTMIN, SIGHTMAX);
      if (candidates.length) interests.push({ state: AiStateType.Interest, node: candidates[this.rnd(candidates.length)], target: -1,
        targetType: AiTargetType.Node, score: 1 });
    }
    if (localAlive && this.targetable(bot, this.localPlayer)) {
      const node = this.waypoints.closestwaypoint(this.localPlayer.position, SIGHTMIN, true);
      if (this.waypoints.iswaypoint(node)) interests.push({ state: AiStateType.Pursue, node, target: -1, targetType: AiTargetType.Player,
        score: distance(bot.position, this.localPlayer.position) / 10 });
    }
    for (const player of players) {
      if (!this.targetable(bot, player)) continue;
      const node = this.waypoints.closestwaypoint(player.position, SIGHTMIN, true);
      if (this.waypoints.iswaypoint(node)) interests.push({ state: AiStateType.Pursue, node, target: this.actorNumber(player),
        targetType: AiTargetType.Player, score: distance(bot.position, player.position) / 10 });
    }
  }

  private findObjectiveInterests(bot: BotActor, interests: AiInterest[]): void {
    if (gameModeHas(this.gameMode, GameModeFlag.Ctf)) {
      const team = bot.team === "good" ? 1 : bot.team === "evil" ? 2 : 0;
      for (const flag of this.entities.filter((entity) => entity.typeName === "flag")) {
        const flagTeam = flag.attributes[1] ?? 0, own = flagTeam === team;
        const protect = gameModeHas(this.gameMode, GameModeFlag.Protect), hold = gameModeHas(this.gameMode, GameModeFlag.Hold);
        const type = hold || own === protect ? AiStateType.Pursue : AiStateType.Defend;
        const node = this.waypoints.closestwaypoint(flag.position, SIGHTMIN, true);
        if (!this.waypoints.iswaypoint(node)) continue;
        const assigned = [...this.bots.values()].filter((other) => other !== bot && other.ai.state.some((candidate) =>
          candidate.targetType === AiTargetType.Affinity && candidate.target === flag.index)).length;
        interests.push({ state: type, node, target: flag.index, targetType: AiTargetType.Affinity,
          score: distance(bot.position, flag.position) * (assigned + 1) / (type === AiStateType.Pursue ? 10 : 4) });
      }
    } else if (gameModeHas(this.gameMode, GameModeFlag.Capture)) {
      for (const base of this.entities.filter((entity) => entity.type === 24)) {
        const node = this.waypoints.closestwaypoint(base.position, SIGHTMIN, true);
        if (!this.waypoints.iswaypoint(node)) continue;
        const assigned = [...this.bots.values()].filter((other) => other !== bot && other.ai.state.some((candidate) =>
          candidate.targetType === AiTargetType.Affinity && candidate.target === base.index)).length;
        interests.push({ state: AiStateType.Defend, node, target: base.index, targetType: AiTargetType.Affinity,
          score: distance(bot.position, base.position) * (assigned + 1) / 6 });
      }
    } else if (gameModeHas(this.gameMode, GameModeFlag.Collect)) {
      for (const base of this.entities.filter((entity) => entity.type === 31)) {
        const node = this.waypoints.closestwaypoint(base.position, SIGHTMIN, true);
        if (this.waypoints.iswaypoint(node)) interests.push({ state: AiStateType.Pursue, node, target: base.index,
          targetType: AiTargetType.Affinity, score: distance(bot.position, base.position) / 8 });
      }
    }
  }

  private parseinterests(bot: BotActor, state: AiState, interests: AiInterest[], now: number): boolean {
    interests.sort((left, right) => left.score - right.score);
    for (const interest of interests) {
      const route = this.makeroute(bot, interest.node);
      if (!route.length) continue;
      bot.ai.route = route;
      state.type = interest.state;
      state.targetType = interest.targetType;
      state.target = interest.target;
      state.millis = now;
      return true;
    }
    return false;
  }

  private hunt(bot: BotActor, state: AiState, now: number): void {
    if (!bot.ai.route.length) {
      const candidates = this.waypoints.findwaypointswithin(bot.position, SIGHTMIN, SIGHTMAX)
        .filter((node) => !bot.ai.previousNodes.includes(node));
      if (candidates.length) bot.ai.route = this.makeroute(bot, candidates[this.rnd(candidates.length)]);
    }
    const node = bot.ai.route.at(-1);
    if (!node || !this.waypoints.iswaypoint(node)) {
      bot.move = bot.strafe = 0;
      state.idle = 1;
      return;
    }
    const spot = this.waypoints.waypoints[node].o;
    bot.ai.spot = copyVec3(spot);
    bot.ai.targetNode = node;
    if (distance(feetPosition(bot), spot) <= WAYPOINTRADIUS) {
      bot.ai.previousNodes.unshift(node);
      bot.ai.previousNodes.length = Math.min(bot.ai.previousNodes.length, 6);
      bot.ai.route.pop();
    }
    this.turnAndMove(bot, spot, now, 0.25);
    if (!bot.timeInAir && spot.z - feetPosition(bot).z >= JUMPMIN && now >= bot.ai.jumpSeed) {
      bot.jumping = true;
      const seed = (111 - bot.skill) * (bot.inWater ? 3 : 5);
      bot.ai.jumpSeed = now + seed + this.rnd(Math.max(seed, 1));
    }
    bot.ai.lastHunt = now;
  }

  private combat(bot: BotActor, enemy: Damageable, now: number): void {
    this.selectWeapon(bot, distance(bot.position, enemy.position));
    const aim = this.getaimpos(bot, enemy, now), delta = subtract(aim, bot.position), dist = magnitude(delta);
    const visible = this.lineOfSight(bot.position, aim, dist);
    if (visible) {
      bot.ai.enemySeen = now;
      this.turnAndMove(bot, aim, now, 1.5, false);
      const definition = WEAPONS[bot.selectedGun], ready = now - bot.lastAction >= bot.gunWait;
      bot.ai.target = findorientation(bot.position, bot.yaw, bot.pitch, definition.range);
      if (ready && dist >= Math.max(definition.explosionRadius, 2) && dist <= definition.range + 4 &&
          this.hastarget(bot, aim, now, definition.attackDelay, definition.projectileSpeed > 0)) {
        bot.weaponSystem.controller.setAttacking(true);
        bot.ai.lastAction = now;
      }
      if (bot.ai.route.length === 0 || now - bot.ai.enemyMillis > 500) {
        const node = this.waypoints.closestwaypoint(enemy.position, SIGHTMIN, true);
        if (this.waypoints.iswaypoint(node)) bot.ai.route = this.makeroute(bot, node);
        bot.ai.enemyMillis = now;
      }
    } else if (bot.ai.enemySeen && now - bot.ai.enemySeen <= bot.skill * 10 + 3000) this.hunt(bot, bot.ai.state.at(-1)!, now);
    else { bot.ai.enemy = -1; bot.ai.enemySeen = bot.ai.enemyMillis = 0; }
  }

  private findEnemy(bot: BotActor, players: readonly Damageable[], localAlive: boolean): Damageable | undefined {
    const targets = [...players, ...this.bots.values()].filter((target) => target !== bot && this.targetable(bot, target));
    if (localAlive && this.targetable(bot, this.localPlayer)) targets.push(this.localPlayer);
    let best: Damageable | undefined, bestDistance = bot.ai.views[2];
    for (const target of targets) {
      const targetDistance = distance(bot.position, target.position);
      if (targetDistance > bestDistance || !this.inView(bot, target.position)) continue;
      if (!this.lineOfSight(bot.position, target.position, targetDistance)) continue;
      best = target; bestDistance = targetDistance;
    }
    if (best) { bot.ai.enemy = this.actorNumber(best); if (!bot.ai.enemyMillis) bot.ai.enemyMillis = performance.now(); }
    return best;
  }

  private makeroute(bot: BotActor, goal: number): number[] {
    if (!this.waypoints.iswaypoint(bot.lastNode)) bot.lastNode = this.waypoints.closestwaypoint(feetPosition(bot), SIGHTMAX, false);
    for (let retries = 0; retries <= 2; retries++) {
      const route = this.waypoints.route(bot.lastNode, goal, { previousNodes: bot.ai.previousNodes, retries });
      if (route.length) return route;
    }
    return [];
  }

  private navigate(bot: BotActor): void {
    const feet = feetPosition(bot), current = this.waypoints.closestwaypoint(feet, WAYPOINTRADIUS, false);
    if (this.waypoints.iswaypoint(current)) {
      if (this.waypoints.iswaypoint(bot.lastNode) && bot.lastNode !== current) {
        bot.ai.previousNodes.unshift(bot.lastNode);
        bot.ai.previousNodes.length = Math.min(bot.ai.previousNodes.length, 6);
      }
      bot.lastNode = current;
    } else if (!this.waypoints.iswaypoint(bot.lastNode) || distance(this.waypoints.waypoints[bot.lastNode].o, feet) > SIGHTMIN) {
      bot.lastNode = this.waypoints.closestwaypoint(feet, SIGHTMAX, false);
    }
  }

  private turnAndMove(bot: BotActor, target: Vec3, now: number, skew: number, move = true): void {
    const desired = yawPitch(bot.position, target), skillModifier = Math.max(101 - bot.skill, 1);
    const frame = Math.min(1, (now - bot.ai.lastRun) / (skillModifier * 10)) * skew;
    bot.yaw = turnAngle(bot.yaw, desired.yaw, frame);
    bot.pitch += (desired.pitch - bot.pitch) * Math.min(1, frame);
    bot.ai.targetYaw = desired.yaw; bot.ai.targetPitch = desired.pitch;
    if (!move) return;
    const relative = normalizeAngle(desired.yaw - bot.yaw), direction = Math.floor((relative + 22.5) / 45) & 7;
    const directions: Array<[-1 | 0 | 1, -1 | 0 | 1]> = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
    [bot.move, bot.strafe] = directions[direction];
  }

  private getaimpos(bot: BotActor, enemy: Damageable, now: number): Vec3 {
    const result = copyVec3(enemy.position);
    if (bot.selectedGun === Gun.Rocket) result.z += enemy.aboveEye * 0.2 - 0.8 * bot.eyeHeight;
    else if (bot.selectedGun !== Gun.Grenade) result.z += (enemy.aboveEye - enemy.eyeHeight) * 0.5;
    const weapon = WEAPONS[bot.selectedGun];
    if (weapon.projectileSpeed && enemy.velocity) {
      const travel = distance(bot.position, result) / weapon.projectileSpeed;
      result.x += enemy.velocity.x * travel; result.y += enemy.velocity.y * travel; result.z += enemy.velocity.z * travel;
    }
    if (bot.skill <= 100 && now >= bot.ai.lastAimRandom) {
      const skew = [1, 10, 50, 5, 20, 1, 100, 10, 10, 10, 1, 1][bot.selectedGun];
      const radius = enemy.radius * skew, range = Math.trunc(radius * 2) + 1, skill = Math.max(bot.skill, 1);
      bot.ai.aimRandom = { x: (this.rnd(range) - radius) / skill, y: (this.rnd(range) - radius) / skill,
        z: (this.rnd(range) - radius) / skill };
      const duration = (bot.skill + 10) * 10;
      bot.ai.lastAimRandom = now + duration + this.rnd(duration);
    }
    result.x += bot.ai.aimRandom.x; result.y += bot.ai.aimRandom.y; result.z += bot.ai.aimRandom.z;
    return result;
  }

  // Original: src/fpsgame/ai.cpp, hastarget().
  private hastarget(bot: BotActor, aim: Vec3, now: number, attackDelay: number, projectile: boolean): boolean {
    if (bot.selectedGun === Gun.Fist) return true;
    const desired = yawPitch(bot.position, aim);
    const denominator = bot.skill * attackDelay / 200;
    const skew = clamp(denominator > 0 ? (now - bot.ai.enemyMillis) / denominator : 1, 0,
      projectile ? 0.25 : Number.MAX_VALUE);
    return Math.abs(shortestAngle(desired.yaw - bot.yaw)) <= bot.ai.views[0] * skew &&
      Math.abs(desired.pitch - bot.pitch) <= bot.ai.views[1] * skew;
  }

  private selectWeapon(bot: BotActor, distanceToEnemy: number): void {
    const inventory = bot.weaponSystem.controller.inventory;
    if (this.forcegun >= Gun.Fist && this.forcegun <= Gun.Pistol && inventory.hasAmmo(this.forcegun)) inventory.select(this.forcegun);
    else {
      const preferences = [Gun.Chaingun, Gun.Rocket, Gun.Shotgun, Gun.Rifle, Gun.Grenade, Gun.Pistol, Gun.Fist];
      const selected = preferences.find((gun) => inventory.hasAmmo(gun) && distanceToEnemy >= Math.max(WEAPONS[gun].explosionRadius, 2) &&
        distanceToEnemy <= WEAPONS[gun].range + 4);
      if (selected !== undefined) inventory.select(selected);
    }
    bot.selectedGun = inventory.selectedGun;
  }

  private lineOfSight(from: Vec3, to: Vec3, maximumDistance: number): boolean {
    const direction = subtract(to, from);
    normalize(direction);
    const hit = this.physics.raycast(from, direction, maximumDistance, 0, true);
    return !hit || hit.distance >= maximumDistance - 1;
  }

  private inView(bot: BotActor, target: Vec3): boolean {
    const desired = yawPitch(bot.position, target);
    return Math.abs(shortestAngle(desired.yaw - bot.yaw)) <= bot.ai.views[0] && Math.abs(desired.pitch - bot.pitch) <= bot.ai.views[1];
  }

  private targetable(bot: BotActor, target: Damageable): boolean {
    if (target === bot || !target.alive) return false;
    const team = "team" in target ? String(target.team) : "";
    return !gameModeHas(this.gameMode, GameModeFlag.Team) || !bot.team || !team || bot.team !== team;
  }

  private itemScore(bot: BotActor, type: number): number {
    if (type >= 8 && type <= 13) return bot.ammo[type - 7] <= 5 ? 100 : 10;
    if (type === 14) return bot.health < 50 ? 1000 : 1;
    if (type === 15) return bot.health < bot.maxHealth ? 500 : 1;
    if (type === 16 || type === 17) return bot.armour < 100 ? 250 : 1;
    if (type === 18) return 1000;
    return 1;
  }

  private hasGoodAmmo(bot: BotActor): boolean {
    return [Gun.Chaingun, Gun.Rocket, Gun.Shotgun, Gun.Rifle].some((gun) => bot.ammo[gun] > 0) || bot.ammo[Gun.Grenade] > 5;
  }

  private chooseSpawn(team: string): RegisteredMapEntity {
    const candidates = this.entities.filter((entity) => entity.type === 3 && (!team || !gameModeHas(this.gameMode, GameModeFlag.Team) ||
      (entity.attributes[1] ?? 0) === (team === "good" ? 1 : 2)));
    const starts = candidates.length ? candidates : this.entities.filter((entity) => entity.type === 3);
    const occupants: Damageable[] = [this.localPlayer, ...this.bots.values()].filter((actor) => actor.alive);
    const safest = starts.map((start) => ({ start, distance: occupants.length
      ? Math.min(...occupants.map((actor) => distance(start.position, actor.position))) : Number.POSITIVE_INFINITY }))
      .sort((left, right) => right.distance - left.distance);
    const top = safest.filter((candidate) => candidate.distance >= (safest[0]?.distance ?? 0) * 0.75);
    return top[this.rnd(top.length)]?.start ?? this.entities.find((entity) => entity.type === 3) ?? {
      index: -1, type: 3, typeName: "playerstart", category: "spawn", position: { x: 0, y: 0, z: 0 }, attributes: [0], namedAttributes: {},
    };
  }

  private chooseTeam(): string {
    if (!gameModeHas(this.gameMode, GameModeFlag.Team)) return "";
    const localTeam = "team" in this.localPlayer ? String(this.localPlayer.team) : "";
    let good = localTeam === "good" ? 1 : 0, evil = localTeam === "evil" ? 1 : 0;
    for (const bot of this.bots.values()) bot.team === "good" ? good++ : evil++;
    return good <= evil ? "good" : "evil";
  }

  private syncTargets(): void {
    const targets: Damageable[] = [this.localPlayer, ...this.bots.values()];
    for (const bot of this.bots.values()) bot.weaponSystem.targets.splice(0, bot.weaponSystem.targets.length, ...targets);
  }

  private syncWeaponState(bot: BotActor): void {
    const controller = bot.weaponSystem.controller;
    bot.selectedGun = controller.inventory.selectedGun;
    bot.lastAction = controller.lastAction;
    bot.gunWait = controller.gunWait;
    bot.lastAttackGun = controller.lastAttackGun;
  }

  private handleWeaponEvent(bot: BotActor, event: WeaponEvent): void {
    this.syncWeaponState(bot);
    if (event.type === "damage" && "ai" in event.target) this.damaged(event.target as BotActor, bot);
    if (event.type === "death" && "ai" in event.target) this.killed(event.target as BotActor, bot);
    this.callbacks.event?.(event, bot);
  }

  private actorNumber(actor: Damageable): number {
    return "clientNumber" in actor ? Number(actor.clientNumber) : actor === this.localPlayer ? -1 : -2;
  }

  private addState(bot: BotActor, type: AiStateType, now: number, targetType = AiTargetType.Node, target = -1): AiState {
    const state = { type, millis: now, targetType, target, idle: 0, override: false };
    bot.ai.state.push(state);
    return state;
  }

  private rnd(maximum: number): number { return maximum > 0 ? Math.floor(this.random() * maximum) : 0; }
}

function createAiInfo(now: number, skill: number): AiInfo {
  return {
    state: [{ type: AiStateType.Wait, millis: now, targetType: AiTargetType.Node, target: -1, idle: 0, override: false }], route: [],
    target: { x: 0, y: 0, z: 0 }, spot: { x: 0, y: 0, z: 0 }, enemy: -1, enemySeen: 0, enemyMillis: 0,
    weaponPreference: Gun.Pistol, previousNodes: [], targetNode: -1, targetLast: -1, targetTime: 0, targetSequence: 0, lastRun: now,
    lastHunt: 0, lastAction: 0, lastCheck: 0, jumpSeed: now, jumpRandom: now + 5000, blockTime: 0, huntSequence: 0,
    blockSequence: 0, lastAimRandom: 0, targetYaw: Math.random() * 360, targetPitch: 0,
    views: [viewfieldx(skill), viewfieldy(skill), viewdist(skill)], aimRandom: { x: 0, y: 0, z: 0 }, dontMove: false, beCareful: false,
  };
}

export function viewdist(skill = 101): number { return skill <= 100 ? clamp((SIGHTMIN + SIGHTMAX - SIGHTMIN) / 100 * skill, SIGHTMIN, SIGHTMAX) : SIGHTMAX; }
export function viewfieldx(skill = 101): number { return skill <= 100 ? clamp((VIEWMIN + VIEWMAX - VIEWMIN) / 100 * skill, VIEWMIN, VIEWMAX) : VIEWMAX; }
export function viewfieldy(skill = 101): number { return viewfieldx(skill) * 3 / 4; }

function feetPosition(actor: PhysicsEntity): Vec3 { return { ...actor.position, z: actor.position.z - actor.eyeHeight }; }
function distance(left: Vec3, right: Vec3): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function normalizeAngle(angle: number): number { return (angle % 360 + 360) % 360; }
function shortestAngle(angle: number): number { const normalized = normalizeAngle(angle); return normalized > 180 ? normalized - 360 : normalized; }
function turnAngle(current: number, target: number, amount: number): number { return normalizeAngle(current + shortestAngle(target - current) * Math.min(1, amount)); }

function yawPitch(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const delta = subtract(to, from), dist = magnitude(delta) || 1;
  return { yaw: normalizeAngle(-Math.atan2(delta.x, delta.y) * 180 / Math.PI), pitch: Math.asin(clamp(delta.z / dist, -1, 1)) * 180 / Math.PI };
}

// Original: src/fpsgame/ai.cpp, findorientation().
// The weapon fires along the actor's current view, not directly at its desired aim point.
export function findorientation(origin: Vec3, yaw: number, pitch: number, distance: number): Vec3 {
  const yawRadians = yaw * Math.PI / 180, pitchRadians = pitch * Math.PI / 180, horizontal = Math.cos(pitchRadians);
  return {
    x: origin.x - Math.sin(yawRadians) * horizontal * distance,
    y: origin.y + Math.cos(yawRadians) * horizontal * distance,
    z: origin.z + Math.sin(pitchRadians) * distance,
  };
}

function signedByte(value: number): number { return value << 24 >> 24; }
