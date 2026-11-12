import { AiType, MAXBOTS } from "./ai";

export const MAXCLIENTS = 128;

export interface AiServerClient {
  clientNumber: number;
  ownerNumber: number;
  aiType: AiType;
  skill: number;
  model: number;
  name: string;
  team: string;
  spectator: boolean;
  local: boolean;
  privilege: number;
  warned: boolean;
  alive: boolean;
  connected: boolean;
  bots: AiServerClient[];
  aiReinit: number;
}

export interface AiManagerCallbacks {
  initAi(client: AiServerClient): void;
  disconnectAi(clientNumber: number): void;
  setTeam(clientNumber: number, team: string): void;
  resumeAi(client: AiServerClient): void;
  leaveGame?(client: AiServerClient): void;
  serverMessage?(message: string): void;
}

// Original: src/fpsgame/aiman.h. This class is transport-independent so both a native-compatible server and a SauerWeb server
// use the same ownership, reassignment, team balancing and authorization rules.
export class AiManager {
  readonly clients: AiServerClient[] = [];
  readonly bots: Array<AiServerClient | undefined> = [];
  botLimit = 8;
  botBalance = true;
  serverBotBalance = true;
  botMode = true;
  teamMode = false;
  private dirty = false;

  constructor(private readonly callbacks: AiManagerCallbacks, private readonly random: () => number = Math.random) {}

  addClient(client: AiServerClient): void {
    if (!this.clients.includes(client)) this.clients.push(client);
    if (client.aiType === AiType.None) this.dirty = true;
  }

  removeClient(client: AiServerClient): void {
    if (client.aiType === AiType.None) this.removeai(client);
    else this.deleteai(client);
    const index = this.clients.indexOf(client);
    if (index >= 0) this.clients.splice(index, 1);
    this.dirty = true;
  }

  addai(skill = -1, limit = this.botLimit): boolean {
    const active = this.bots.filter((bot) => bot?.ownerNumber !== undefined && bot.ownerNumber >= 0).length;
    if (active >= Math.min(limit < 0 ? MAXBOTS : limit, MAXBOTS)) return false;
    let slot = this.bots.findIndex((bot) => !bot || bot.ownerNumber < 0);
    if (slot < 0) { slot = this.bots.length; this.bots.push(undefined); }
    const reusable = this.bots[slot], owner = this.findaiclient();
    if (reusable) {
      reusable.ownerNumber = owner?.clientNumber ?? -1;
      if (owner) owner.bots.push(reusable);
      reusable.aiReinit = 2;
      this.dirty = true;
      return true;
    }
    const client: AiServerClient = {
      clientNumber: MAXCLIENTS + slot,
      ownerNumber: owner?.clientNumber ?? -1,
      aiType: AiType.Bot,
      skill: skill <= 0 ? 51 + this.rnd(50) : clamp(skill, 1, 101),
      model: this.rnd(128),
      name: "bot",
      team: this.teamMode ? this.chooseteam() : "",
      spectator: false,
      local: false,
      privilege: 0,
      warned: false,
      alive: false,
      connected: true,
      bots: [],
      aiReinit: 2,
    };
    this.bots[slot] = client;
    this.clients.push(client);
    owner?.bots.push(client);
    this.dirty = true;
    return true;
  }

  deleteai(client?: AiServerClient): boolean {
    const target = client ?? [...this.bots].reverse().find((bot) => bot && bot.ownerNumber >= 0);
    if (!target || target.aiType === AiType.None) return false;
    if (target.ownerNumber >= 0 && !target.aiReinit) this.callbacks.leaveGame?.(target);
    this.callbacks.disconnectAi(target.clientNumber);
    const owner = this.client(target.ownerNumber);
    if (owner) removeObject(owner.bots, target);
    removeObject(this.clients, target);
    const slot = target.clientNumber - MAXCLIENTS;
    if (slot >= 0 && slot < this.bots.length) this.bots[slot] = undefined;
    this.dirty = true;
    return true;
  }

  reqadd(requester: AiServerClient, skill: number): boolean {
    if (!requester.local && !requester.privilege) return false;
    const limit = !requester.local && requester.privilege < 2 ? this.botLimit : -1;
    const result = this.addai(skill, limit);
    if (!result) this.callbacks.serverMessage?.("failed to create or assign bot");
    return result;
  }

  reqdel(requester: AiServerClient): boolean {
    if (!requester.local && !requester.privilege) return false;
    const result = this.deleteai();
    if (!result) this.callbacks.serverMessage?.("failed to remove any bots");
    return result;
  }

  setbotlimit(requester: AiServerClient | undefined, limit: number): void {
    if (requester && !requester.local && requester.privilege < 2) return;
    this.botLimit = clamp(limit, 0, MAXBOTS);
    this.dirty = true;
    this.callbacks.serverMessage?.(`bot limit is now ${this.botLimit}`);
  }

  setbotbalance(requester: AiServerClient | undefined, enabled: boolean): void {
    if (requester && !requester.local && !requester.privilege) return;
    this.botBalance = enabled;
    this.dirty = true;
    this.callbacks.serverMessage?.(`bot team balancing is now ${enabled ? "enabled" : "disabled"}`);
  }

  changemap(): void {
    this.dirty = true;
    if (!this.clients.some((client) => client.local || client.privilege)) this.setbotbalance(undefined, this.serverBotBalance);
  }

  changeteam(client: AiServerClient): void { if (client.aiType === AiType.None) this.dirty = true; }

  checkai(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const hasHuman = this.clients.some((client) => client.aiType === AiType.None && !client.spectator);
    if (!this.botMode || !hasHuman) { this.clearai(); return; }
    if (this.teamMode && this.botBalance) this.balanceteams();
    for (let index = this.bots.length - 1; index >= 0; index--) {
      const bot = this.bots[index];
      if (bot) this.reinitai(bot);
    }
    while (this.reassignai()) {}
  }

  clearai(): void {
    for (let index = this.bots.length - 1; index >= 0; index--) if (this.bots[index]) this.deleteai(this.bots[index]);
  }

  private validaiclient(client: AiServerClient): boolean {
    return client.clientNumber >= 0 && client.aiType === AiType.None && (!client.spectator || client.local || Boolean(client.privilege && !client.warned));
  }

  private findaiclient(exclude?: AiServerClient): AiServerClient | undefined {
    return this.clients.filter((client) => client !== exclude && this.validaiclient(client))
      .sort((left, right) => left.bots.length - right.bots.length)[0];
  }

  private reinitai(client: AiServerClient): void {
    if (client.ownerNumber < 0) this.deleteai(client);
    else if (client.aiReinit >= 1) {
      this.callbacks.initAi(client);
      if (client.aiReinit === 2) this.callbacks.resumeAi(client);
      client.aiReinit = 0;
    }
  }

  private shiftai(client: AiServerClient, owner?: AiServerClient): void {
    if (client.ownerNumber >= 0 && !client.aiReinit) this.callbacks.leaveGame?.(client);
    const previous = this.client(client.ownerNumber);
    if (previous) removeObject(previous.bots, client);
    if (!owner) { client.aiReinit = 0; client.ownerNumber = -1; }
    else if (client.ownerNumber !== owner.clientNumber) {
      client.aiReinit = 2;
      client.ownerNumber = owner.clientNumber;
      owner.bots.push(client);
    }
    this.dirty = true;
  }

  private removeai(client: AiServerClient): void {
    for (let index = client.bots.length - 1; index >= 0; index--) this.shiftai(client.bots[index], this.findaiclient(client));
  }

  private reassignai(): boolean {
    const humans = this.clients.filter((client) => this.validaiclient(client)).sort((left, right) => left.bots.length - right.bots.length);
    const low = humans[0], high = humans.at(-1);
    if (!low || !high || high.bots.length - low.bots.length <= 1) return false;
    this.shiftai(high.bots.at(-1)!, low);
    return true;
  }

  private balanceteams(): void {
    const teams = this.calcteams(), reassign = this.bots.filter((bot): bot is AiServerClient => Boolean(bot));
    while (reassign.length && teams.length > 1 && teams[0].score > teams.at(-1)!.score + 1) {
      const high = teams[0], low = teams.at(-1)!;
      const index = reassign.findIndex((bot) => bot.team === high.team);
      if (index < 0) { teams.shift(); continue; }
      const bot = reassign.splice(index, 1)[0];
      high.score--; low.score++;
      bot.team = low.team;
      this.callbacks.setTeam(bot.clientNumber, low.team);
      teams.sort((left, right) => right.score - left.score);
    }
  }

  private chooseteam(): string { return this.calcteams().at(-1)?.team ?? ""; }

  private calcteams(): Array<{ team: string; score: number }> {
    const scores = new Map<string, number>();
    for (const client of this.clients) if (!client.spectator && client.team) scores.set(client.team, (scores.get(client.team) ?? 0) + 1);
    for (const team of ["good", "evil"]) if (!scores.has(team)) scores.set(team, 0);
    return [...scores].map(([team, score]) => ({ team, score })).sort((left, right) => right.score - left.score);
  }

  private client(clientNumber: number): AiServerClient | undefined { return this.clients.find((client) => client.clientNumber === clientNumber); }
  private rnd(maximum: number): number { return maximum > 0 ? Math.floor(this.random() * maximum) : 0; }
}

function removeObject<T>(values: T[], value: T): void { const index = values.indexOf(value); if (index >= 0) values.splice(index, 1); }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, Math.trunc(value))); }
