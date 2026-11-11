export interface EmscriptenEnetModule {
  HEAPU8: Uint8Array;
  _malloc(length: number): number;
  _free(pointer: number): void;
  _sauer_enet_create(port: number, channels: number): number;
  _sauer_enet_service(): number;
  _sauer_enet_event_channel(): number;
  _sauer_enet_event_data(): number;
  _sauer_enet_event_flags(): number;
  _sauer_enet_event_packet(): number;
  _sauer_enet_event_length(): number;
  _sauer_enet_event_done(): void;
  _sauer_enet_send(channel: number, data: number, length: number, flags: number): number;
  _sauer_enet_flush(): void;
  _sauer_enet_disconnect(data: number): void;
  _sauer_enet_destroy(): void;
  _sauer_enet_queue_incoming(data: number, length: number): void;
  _sauer_enet_outgoing_data(): number;
  _sauer_enet_outgoing_length(): number;
  _sauer_enet_pop_outgoing(): void;
}

export default function createEnetModule(options?: { locateFile?(path: string): string }): Promise<EmscriptenEnetModule>;
