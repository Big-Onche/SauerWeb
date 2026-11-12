import dgram from "node:dgram";
import http from "node:http";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { attachPresence, attachSauerRelay, parseMasterServerList, parseTrustedProxies, resolveClientAddress } from "./relay.mjs";

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

  it("preserves complete binary datagrams in both directions", async () => {
    const udp = dgram.createSocket("udp4");
    await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const target = { host: "127.0.0.1", port: udp.address().port, label: "echo" };
    udp.on("message", (datagram, remote) => udp.send(datagram, remote.port, remote.address));
    const server = http.createServer();
    const relay = attachSauerRelay(server, { servers: [target], updateServers: async () => [target] });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/relay?server=${target.host}&port=${target.port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const sent = Buffer.from([0xFF, 0x00, 0x80, 0x01, 0x7F]);
    const received = new Promise((resolve, reject) => {
      client.once("message", (datagram, isBinary) => isBinary ? resolve(Buffer.from(datagram)) : reject(new Error("Text relay frame")));
      client.once("error", reject);
    });
    client.send(sent, { binary: true });
    await expect(received).resolves.toEqual(sent);
    await new Promise((resolve) => { client.once("close", resolve); client.close(); });
    relay.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => udp.close(resolve));
  });
});

describe("browser presence", () => {
  it("counts unique sessions, replaces a resumed session, and expires stale sessions", async () => {
    const server = http.createServer();
    const presence = attachPresence(server, { staleMilliseconds: 80, sweepMilliseconds: 10 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = (session) => `ws://127.0.0.1:${server.address().port}/presence?session=${session}`;
    const first = new WebSocket(url("11111111-1111-4111-8111-111111111111"));
    const firstCount = nextPresenceCount(first);
    await opened(first);
    await expect(firstCount).resolves.toBe(1);

    const second = new WebSocket(url("22222222-2222-4222-8222-222222222222"));
    const firstSeesTwo = nextPresenceCount(first);
    const secondSeesTwo = nextPresenceCount(second);
    await opened(second);
    await expect(firstSeesTwo).resolves.toBe(2);
    await expect(secondSeesTwo).resolves.toBe(2);

    const resumed = new WebSocket(url("11111111-1111-4111-8111-111111111111"));
    const replaced = new Promise((resolve) => first.once("close", resolve));
    await opened(resumed);
    await replaced;
    resumed.send("heartbeat");
    const resumedCounts = [];
    resumed.on("message", (payload) => resumedCounts.push(JSON.parse(payload.toString()).count));
    await new Promise((resolve) => setTimeout(resolve, 55));
    resumed.send("heartbeat");
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(resumedCounts).toContain(1);

    resumed.close();
    second.close();
    presence.close();
    await new Promise((resolve) => server.close(resolve));
  });
});

function opened(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("open", resolve);
    webSocket.once("error", reject);
  });
}

function nextPresenceCount(webSocket) {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (payload) => resolve(JSON.parse(payload.toString()).count));
    webSocket.once("error", reject);
  });
}
