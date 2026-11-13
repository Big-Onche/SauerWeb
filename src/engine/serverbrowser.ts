// Original: src/engine/serverbrowser.cpp
// Functions: retrieveservers(), updatefrommaster(), refreshservers(), sortservers(), serverinfostartcolumn()
// Sauerbraten reference: SVN r6488

import { PacketReader, PacketWriter } from "../network/protocol";

export interface ServerListItem {
  host: string;
  port: number;
  label: string;
  online: boolean;
  ping: number | null;
  numPlayers?: number;
  attributes?: number[];
  map?: string;
  description?: string;
  keep?: boolean;
}

export async function retrieveservers(searchlan = false): Promise<ServerListItem[]> {
  const query = searchlan ? "?targets=1&searchlan=1" : "?targets=1";
  const response = await fetch(`/api/servers${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Server index returned ${response.status}.`);
  const servers = await response.json() as ServerListItem[];
  return queryservers(servers);
}

export async function queryservers(servers: ServerListItem[], concurrency = 4): Promise<ServerListItem[]> {
  const results = new Array<ServerListItem>(servers.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < servers.length; index = next++) results[index] = await queryserver(servers[index]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, worker));
  return results;
}

async function queryserver(server: ServerListItem): Promise<ServerListItem> {
  return new Promise((resolve) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${location.host}/relay`);
    url.searchParams.set("server", server.host);
    url.searchParams.set("port", String(server.port));
    url.searchParams.set("info", "1");
    const socket = new WebSocket(url);
    let result: ServerListItem | undefined;
    const offline = (): ServerListItem => ({ ...server, ping: null, online: false });
    const finish = (value: ServerListItem): void => {
      if (result) return;
      result = value;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) resolve(value);
      else socket.close();
    };
    const timeout = setTimeout(() => finish(offline()), 1200);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      const started = performance.now();
      socket.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        try { finish(decodeServerInfo(new Uint8Array(event.data), performance.now() - started, server)); }
        catch { finish(offline()); }
      }, { once: true });
      socket.send(new PacketWriter().putInt(Math.trunc(started)).finish());
    }, { once: true });
    socket.addEventListener("error", () => finish(offline()), { once: true });
    socket.addEventListener("close", () => resolve(result ?? offline()), { once: true });
  });
}

export function decodeServerInfo(bytes: Uint8Array, ping: number, server: ServerListItem): ServerListItem {
  const packet = new PacketReader(bytes);
  packet.getInt();
  const numPlayers = packet.getInt(), attributeCount = packet.getInt();
  if (attributeCount < 0 || attributeCount > 64) throw new RangeError("Invalid Sauerbraten server attribute count.");
  const attributes = Array.from({ length: attributeCount }, () => packet.getInt());
  return {
    ...server, ping: Math.max(0, Math.trunc(ping)), online: true, numPlayers, attributes,
    map: packet.getString(), description: packet.getString(),
  };
}

export async function updatefrommaster(searchlan = false): Promise<ServerListItem[]> {
  return retrieveservers(searchlan);
}

export async function refreshservers(searchlan = false): Promise<ServerListItem[]> {
  return updatefrommaster(searchlan);
}

export function sortservers(servers: ServerListItem[]): ServerListItem[] {
  return [...servers].sort((a, b) => {
    const compatibleDifference = Number(servercompatible(b)) - Number(servercompatible(a));
    if (compatibleDifference) return compatibleDifference;
    const keepDifference = Number(Boolean(b.keep)) - Number(Boolean(a.keep));
    if (keepDifference) return keepDifference;
    const playerDifference = (b.numPlayers ?? 0) - (a.numPlayers ?? 0);
    if (playerDifference) return playerDifference;
    const pingDifference = (a.ping ?? Number.MAX_SAFE_INTEGER) - (b.ping ?? Number.MAX_SAFE_INTEGER);
    if (pingDifference) return pingDifference;
    const hostDifference = a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
    return hostDifference || a.port - b.port;
  });
}

export function servercompatible(server: ServerListItem): boolean {
  return server.online && server.attributes?.[0] === 260;
}

export function servermodename(mode: number | undefined): string {
  const names = ["SP", "DMSP", "demo", "ffa", "coop edit", "teamplay", "instagib", "insta team", "efficiency", "effic team", "tactics",
    "tac team", "capture", "regen capture", "ctf", "insta ctf", "protect", "insta protect", "hold", "insta hold", "effic ctf",
    "effic protect", "effic hold", "collect", "insta collect", "effic collect"];
  return mode === undefined ? "—" : names[mode + 3] ?? String(mode);
}
