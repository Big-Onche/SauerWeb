const HEARTBEAT_MILLISECONDS = 15_000;
const MAX_RECONNECT_MILLISECONDS = 15_000;

export function onlinePlayersLabel(count: number): string {
  return `${count} ${count > 1 ? "players" : "player"} on SauerWeb right now!`;
}

export class OnlinePresence extends EventTarget {
  count: number | undefined;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private reconnectMilliseconds = 1_000;
  private stopped = false;
  private readonly sessionId = presenceSessionId();

  constructor() {
    super();
    this.connect();
    window.addEventListener("pagehide", () => this.stop());
    window.addEventListener("pageshow", () => {
      if (!this.stopped) return;
      this.stopped = false;
      this.connect();
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL("/presence", `${protocol}//${location.host}`);
    url.searchParams.set("session", this.sessionId);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectMilliseconds = 1_000;
      this.sendHeartbeat();
      this.heartbeat = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MILLISECONDS);
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { type?: unknown; count?: unknown };
        if (message.type !== "presence" || !Number.isSafeInteger(message.count) || Number(message.count) < 0) return;
        this.setCount(Number(message.count));
      } catch {}
    });
    const disconnected = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.setCount(undefined);
      if (this.stopped || this.reconnect !== undefined) return;
      this.reconnect = setTimeout(() => {
        this.reconnect = undefined;
        this.connect();
      }, this.reconnectMilliseconds);
      this.reconnectMilliseconds = Math.min(this.reconnectMilliseconds * 2, MAX_RECONNECT_MILLISECONDS);
    };
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
  }

  private sendHeartbeat(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send("heartbeat");
  }

  private setCount(count: number | undefined): void {
    if (this.count === count) return;
    this.count = count;
    this.dispatchEvent(new Event("change"));
  }

  private stop(): void {
    this.stopped = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.reconnect !== undefined) clearTimeout(this.reconnect);
    this.heartbeat = undefined;
    this.reconnect = undefined;
    this.setCount(undefined);
    this.socket?.close(1000, "Page closed");
  }
}

function presenceSessionId(): string {
  const key = "sauerweb-presence-session";
  const stored = sessionStorage.getItem(key);
  if (stored && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(stored)) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(key, id);
  return id;
}
