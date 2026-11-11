import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Http2SecureServer } from "node:http2";

export interface RelayServer { host: string; port: number; label: string }
export function configuredServers(environment?: NodeJS.ProcessEnv): RelayServer[];
export function attachSauerRelay(server: Server | Http2SecureServer,
                                 options?: { servers?: RelayServer[] }): { servers: RelayServer[]; close(): void };
export function queryConfiguredServers(servers?: RelayServer[]): Promise<unknown[]>;
export function serverListMiddleware(servers?: RelayServer[]): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
