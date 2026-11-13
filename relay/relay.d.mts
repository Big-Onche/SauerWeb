import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Http2SecureServer } from "node:http2";

export interface RelayServer { host: string; port: number; label: string; keep?: boolean }
export interface ServerConfig { host: string; port: number; name?: string; domain?: string; autoauth: boolean; maxclients?: number }
export interface TrustedProxy { family: number; prefix: number; network: bigint }
export function configuredServers(environment?: NodeJS.ProcessEnv): RelayServer[];
export function relayConfiguration(environment?: NodeJS.ProcessEnv): { servers: RelayServer[]; serverConfigs: Map<string, ServerConfig> };
export function attachSauerRelay(server: Server | Http2SecureServer,
                                 options?: { servers?: RelayServer[]; trustedProxies?: string | string[];
                                   updateServers?: (servers: RelayServer[]) => Promise<RelayServer[]>; serverConfigs?: Map<string, ServerConfig>;
                                   slotDirectory?: string }): { servers: RelayServer[]; close(): void };
export class SharedSlotLimiter {
  constructor(directory?: string);
  reserve(key: string, maximum: number): Promise<{ release(): void } | undefined>;
}
export function attachPresence(server: Server | Http2SecureServer, options?: { staleMilliseconds?: number; sweepMilliseconds?: number }): {
  close(): void;
};
export function resolveClientAddress(request: IncomingMessage, trustedProxies?: TrustedProxy[]): string;
export function parseTrustedProxies(value: string | string[]): TrustedProxy[];
export function queryConfiguredServers(servers?: RelayServer[]): Promise<unknown[]>;
export function discoverLanServers(timeout?: number): Promise<unknown[]>;
export function retrieveservers(environment?: NodeJS.ProcessEnv): Promise<string>;
export function parseMasterServerList(data: string): RelayServer[];
export function updatefrommaster(keepservers?: RelayServer[], environment?: NodeJS.ProcessEnv): Promise<RelayServer[]>;
export function serverListMiddleware(servers?: RelayServer[], environment?: NodeJS.ProcessEnv):
  (request: IncomingMessage, response: ServerResponse) => Promise<void>;
