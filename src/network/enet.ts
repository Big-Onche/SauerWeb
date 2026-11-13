import createEnetModule, { type EmscriptenEnetModule } from "./enet/generated/enet.js";

export const ENET_PACKET_FLAG_RELIABLE = 1;
export const ENET_PACKET_FLAG_UNSEQUENCED = 2;

export interface EnetPacketEvent {
  type: "receive";
  channel: number;
  flags: number;
  data: Uint8Array;
}

export interface EnetConnectionEvent {
  type: "connect" | "disconnect";
  data: number;
}

export interface EnetControlEvent {
  type: "control";
  data: { type: "teamkill-warning"; count: number } | { type: "teamkill-disconnect"; cooldownMilliseconds: number };
}

export type EnetEvent = EnetPacketEvent | EnetConnectionEvent | EnetControlEvent;

// Original: src/engine/client.cpp
// Functions: connectserv(), gets2c(), c2sinfo(), disconnect()
// Sauerbraten reference: SVN r6488
export class EnetClient extends EventTarget {
  private module?: EmscriptenEnetModule;
  private socket?: WebSocket;
  private serviceTimer?: ReturnType<typeof setInterval>;

  async connect(relayUrl: string, server: string, port: number): Promise<void> {
    this.close();
    const module = await createEnetModule();
    const socketUrl = new URL(relayUrl, location.href);
    socketUrl.searchParams.set("server", server);
    socketUrl.searchParams.set("port", String(port));
    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new Error("The Sauerbraten relay connection failed."));
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
    if (module._sauer_enet_create(port, 3) !== 0) {
      socket.close();
      throw new Error("ENet could not create a client host.");
    }
    this.module = module;
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handleControl(event.data);
      else this.queueIncoming(new Uint8Array(event.data as ArrayBuffer));
    });
    socket.addEventListener("close", () => this.dispatchEvent(new CustomEvent<EnetConnectionEvent>("enet", {
      detail: { type: "disconnect", data: 0 },
    })));
    this.serviceTimer = setInterval(() => this.service(), 5);
    this.service();
  }

  send(channel: number, bytes: Uint8Array, reliable = false): void {
    const module = this.requiredModule();
    const pointer = this.copyToWasm(bytes);
    try {
      const result = module._sauer_enet_send(channel, pointer, bytes.length, reliable ? ENET_PACKET_FLAG_RELIABLE : 0);
      if (result < 0) throw new Error(`ENet packet send failed (${result}).`);
    } finally {
      module._free(pointer);
    }
  }

  flush(): void {
    this.requiredModule()._sauer_enet_flush();
    this.flushDatagrams();
  }

  disconnect(data = 0): void {
    if (!this.module) return;
    this.module._sauer_enet_disconnect(data);
    this.service();
  }

  reportTeamkill(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "teamkill" }));
  }

  close(): void {
    if (this.serviceTimer) clearInterval(this.serviceTimer);
    this.serviceTimer = undefined;
    this.module?._sauer_enet_destroy();
    this.module = undefined;
    this.socket?.close();
    this.socket = undefined;
  }

  private service(): void {
    const module = this.module;
    if (!module) return;
    for (let count = 0; count < 256; count++) {
      const eventType = module._sauer_enet_service();
      this.flushDatagrams();
      if (!eventType) break;
      const detail: EnetEvent = eventType === 3 ? {
        type: "receive",
        channel: module._sauer_enet_event_channel(),
        flags: module._sauer_enet_event_flags(),
        data: module.HEAPU8.slice(module._sauer_enet_event_packet(),
          module._sauer_enet_event_packet() + module._sauer_enet_event_length()),
      } : { type: eventType === 1 ? "connect" : "disconnect", data: module._sauer_enet_event_data() };
      module._sauer_enet_event_done();
      this.dispatchEvent(new CustomEvent<EnetEvent>("enet", { detail }));
    }
  }

  private queueIncoming(bytes: Uint8Array): void {
    const module = this.module;
    if (!module) return;
    const pointer = this.copyToWasm(bytes);
    module._sauer_enet_queue_incoming(pointer, bytes.length);
    module._free(pointer);
    this.service();
  }

  private handleControl(message: string): void {
    try {
      const data = JSON.parse(message) as EnetControlEvent["data"];
      if (data.type === "teamkill-warning" && (!Number.isInteger(data.count) || data.count < 1)) return;
      if (data.type === "teamkill-disconnect" && (!Number.isFinite(data.cooldownMilliseconds) || data.cooldownMilliseconds <= 0)) return;
      if (data.type !== "teamkill-warning" && data.type !== "teamkill-disconnect") return;
      this.dispatchEvent(new CustomEvent<EnetControlEvent>("enet", { detail: { type: "control", data } }));
    } catch {}
  }

  private flushDatagrams(): void {
    const module = this.module;
    const socket = this.socket;
    if (!module || socket?.readyState !== WebSocket.OPEN) return;
    for (let length = module._sauer_enet_outgoing_length(); length; length = module._sauer_enet_outgoing_length()) {
      const pointer = module._sauer_enet_outgoing_data();
      socket.send(module.HEAPU8.slice(pointer, pointer + length));
      module._sauer_enet_pop_outgoing();
    }
  }

  private copyToWasm(bytes: Uint8Array): number {
    const module = this.requiredModule();
    const pointer = module._malloc(Math.max(1, bytes.length));
    if (!pointer) throw new Error("ENet WebAssembly allocation failed.");
    module.HEAPU8.set(bytes, pointer);
    return pointer;
  }

  private requiredModule(): EmscriptenEnetModule {
    if (!this.module) throw new Error("ENet is not connected.");
    return this.module;
  }
}
