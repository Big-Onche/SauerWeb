import { afterEach, describe, expect, it, vi } from "vitest";
import { PacketWriter } from "../network/protocol";
import { decodeServerInfo, queryservers, sortservers, type ServerListItem } from "./serverbrowser";

function server(host: string, numPlayers: number, ping: number | null, attributes = [260], keep?: boolean): ServerListItem {
  return { host, port: 28785, label: host, online: ping !== null, ping, numPlayers, attributes, keep };
}

describe("Sauerbraten server browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

  it("ignores relay control messages while waiting for the binary server info reply", async () => {
    const response = new PacketWriter().putInt(1234).putInt(2).putInt(2).putInt(260).putInt(3)
      .putString("complex").putString("test server").finish();
    installWebSocket((socket) => {
      socket.message(JSON.stringify({ type: "auth-config", autoauth: true }));
      socket.message(Uint8Array.from(response).buffer);
    });

    await expect(queryservers([server("example.test", 0, null)])).resolves.toMatchObject([
      { host: "example.test", online: true, numPlayers: 2, map: "complex" },
    ]);
  });

  it("retries a dropped server info query before marking the server offline", async () => {
    vi.useFakeTimers();
    const response = new PacketWriter().putInt(1234).putInt(1).putInt(1).putInt(260)
      .putString("forge").putString("busy server").finish();
    let sends = 0;
    installWebSocket((socket) => {
      sends++;
      if (sends === 2) socket.message(Uint8Array.from(response).buffer);
    });

    const queried = queryservers([server("example.test", 0, null)]);
    await vi.advanceTimersByTimeAsync(600);

    await expect(queried).resolves.toMatchObject([{ online: true, numPlayers: 1, map: "forge" }]);
    expect(sends).toBe(2);
  });
});

function installWebSocket(onSend: (socket: FakeWebSocket) => void): void {
  vi.stubGlobal("location", { protocol: "https:", host: "web.test" });
  vi.stubGlobal("WebSocket", class extends FakeWebSocket {
    constructor(url: URL) { super(url, onSend); }
  });
}

class FakeWebSocket extends EventTarget {
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  binaryType = "";
  readyState = 1;

  constructor(readonly url: URL, private readonly onSend: (socket: FakeWebSocket) => void) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(): void { this.onSend(this); }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  message(data: string | ArrayBuffer): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    queueMicrotask(() => this.dispatchEvent(event));
  }
}
