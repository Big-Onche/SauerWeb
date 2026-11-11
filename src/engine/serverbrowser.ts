// Original: src/engine/serverbrowser.cpp
// Functions: retrieveservers(), updatefrommaster(), refreshservers(), serverinfostartcolumn()
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
}

export async function retrieveservers(): Promise<ServerListItem[]> {
  const response = await fetch("/api/servers", { cache: "no-store" });
  if (!response.ok) throw new Error(`Server index returned ${response.status}.`);
  return response.json() as Promise<ServerListItem[]>;
}

export async function updatefrommaster(): Promise<ServerListItem[]> {
  return retrieveservers();
}

export async function refreshservers(): Promise<ServerListItem[]> {
  return updatefrommaster();
}

export function servermodename(mode: number | undefined): string {
  const names = ["SP", "DMSP", "demo", "ffa", "coop edit", "teamplay", "instagib", "insta team", "efficiency", "effic team", "tactics",
    "tac team", "capture", "regen capture", "ctf", "insta ctf", "protect", "insta protect", "hold", "insta hold", "effic ctf",
    "effic protect", "effic hold", "collect", "insta collect", "effic collect"];
  return mode === undefined ? "—" : names[mode + 3] ?? String(mode);
}
