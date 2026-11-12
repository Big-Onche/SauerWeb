import http from "node:http";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { attachSauerRelay, parseMasterServerList, parseTrustedProxies, resolveClientAddress } from "./relay.mjs";

describe("parseMasterServerList", () => {
  it("parses and deduplicates the original addserver format", () => {
    expect(parseMasterServerList([
      "echo Sauerbraten server list",
      "addserver 192.0.2.1 28785",
      "addserver play.example.net 30000",
      "addserver 192.0.2.1 28785",
      "",
    ].join("\n"))).toEqual([
      { host: "192.0.2.1", port: 28785, label: "192.0.2.1" },
      { host: "play.example.net", port: 30000, label: "play.example.net" },
    ]);
  });

  it("ignores malformed and unsafe destinations", () => {
    expect(parseMasterServerList([
      "addserver example.net 0",
      "addserver example.net 65535",
      "addserver bad/host 28785",
      "addserver -bad.example 28785",
      "addserver example.net not-a-port",
      "addserver example.net 28785 password",
    ].join("\n"))).toEqual([]);
  });
});

describe("resolveClientAddress", () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });

  it("uses a forwarded client address only when the direct peer is trusted", () => {
    const trusted = parseTrustedProxies("127.0.0.1/32,::1/128");
    expect(resolveClientAddress(request("127.0.0.1", "203.0.113.8"), trusted)).toBe("203.0.113.8");
    expect(resolveClientAddress(request("198.51.100.4", "203.0.113.8"), trusted)).toBe("198.51.100.4");
  });

  it("walks proxy hops from right to left so a client cannot spoof the leftmost value", () => {
    const trusted = parseTrustedProxies("127.0.0.1/32,10.0.0.0/8");
    expect(resolveClientAddress(request("127.0.0.1", "192.0.2.123, 203.0.113.8"), trusted)).toBe("203.0.113.8");
    expect(resolveClientAddress(request("127.0.0.1", "192.0.2.123, 203.0.113.8, 10.0.0.7"), trusted)).toBe("203.0.113.8");
  });

  it("normalizes IPv4-mapped loopback addresses", () => {
    const trusted = parseTrustedProxies("127.0.0.1/32");
    expect(resolveClientAddress(request("::ffff:127.0.0.1", "203.0.113.8"), trusted)).toBe("203.0.113.8");
  });
});

describe("relay connection limits", () => {
  it("atomically limits concurrent upgrades to four connections per resolved client address", async () => {
    const target = { host: "127.0.0.1", port: 28785, label: "test" };
    let finishRefresh;
    const refresh = new Promise((resolve) => { finishRefresh = resolve; });
    const server = http.createServer();
    const relay = attachSauerRelay(server, {
      servers: [],
      trustedProxies: "127.0.0.1/32",
      updateServers: () => refresh,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const clientAddresses = [...Array.from({ length: 5 }, () => "203.0.113.8"), "198.51.100.9"];
    const clients = clientAddresses.map((address) => new WebSocket(
      `ws://127.0.0.1:${port}/relay?server=${target.host}&port=${target.port}`,
      { headers: { "X-Forwarded-For": address } },
    ));
    const outcomes = clients.map((client) => new Promise((resolve) => {
      client.once("open", () => resolve(101));
      client.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
      client.once("error", () => resolve(0));
    }));
    finishRefresh([target]);
    expect((await Promise.all(outcomes)).sort()).toEqual([101, 101, 101, 101, 101, 403]);
    await Promise.all(clients.filter((client) => client.readyState === WebSocket.OPEN).map((client) => new Promise((resolve) => {
      client.once("close", resolve);
      client.close();
    })));
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
});
