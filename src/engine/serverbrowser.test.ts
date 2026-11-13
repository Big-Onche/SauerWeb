import { describe, expect, it } from "vitest";
import { PacketWriter } from "../network/protocol";
import { decodeServerInfo, sortservers, type ServerListItem } from "./serverbrowser";

function server(host: string, numPlayers: number, ping: number | null, attributes = [260], keep?: boolean): ServerListItem {
  return { host, port: 28785, label: host, online: ping !== null, ping, numPlayers, attributes, keep };
}

describe("Sauerbraten server browser", () => {
  it("sorts compatible servers by player count descending, then ping and host", () => {
    const sorted = sortservers([
      server("empty", 0, 10), server("slower", 4, 70), server("faster", 4, 20), server("b-host", 2, 30), server("a-host", 2, 30),
    ]);

    expect(sorted.map((item) => item.host)).toEqual(["faster", "slower", "a-host", "b-host", "empty"]);
  });

  it("keeps native compatibility and configured-server priorities ahead of player count", () => {
    const sorted = sortservers([
      server("incompatible", 20, 10, [259]), server("master", 8, 20), server("configured", 1, 90, [260], true), server("offline", 30, null),
    ]);

    expect(sorted.map((item) => item.host)).toEqual(["configured", "master", "offline", "incompatible"]);
  });

  it("keeps the browser-measured RTT while decoding the vanilla info response", () => {
    const bytes = new PacketWriter().putInt(1234).putInt(2).putInt(2).putInt(260).putInt(3)
      .putString("complex").putString("test server").finish();

    expect(decodeServerInfo(bytes, 48.9, server("example.test", 0, null))).toMatchObject({
      ping: 48, online: true, numPlayers: 2, attributes: [260, 3], map: "complex", description: "test server",
    });
  });
});
