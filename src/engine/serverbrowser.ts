// Original: src/engine/serverbrowser.cpp
// Functions: retrieveservers(), updatefrommaster(), refreshservers(), sortservers(), serverinfostartcolumn()
// Sauerbraten reference: SVN r6488

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
  const query = searchlan ? "?searchlan=1" : "";
  const response = await fetch(`/api/servers${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Server index returned ${response.status}.`);
  return response.json() as Promise<ServerListItem[]>;
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
