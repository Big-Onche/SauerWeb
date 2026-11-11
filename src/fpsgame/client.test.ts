import { describe, expect, it } from "vitest";
import { PacketReader } from "../network/protocol";
import { serializeShoot, type NetworkPlayer } from "./client";
import { DMF, DNF, NetworkMessage } from "./game";
import { createDamageable } from "./weapon/DamageSystem";
import { Gun } from "./weapon/WeaponDefinitions";
import type { WeaponEvent } from "./weapon/WeaponEvents";

describe("Sauerbraten rifle protocol", () => {
  it("serializes the exact native N_SHOOT fields and hit record", () => {
    const target = Object.assign(createDamageable("client:7", { x: 0, y: 50, z: 14 }), {
      clientNumber: 7, lifeSequence: 3,
    }) as NetworkPlayer;
    const event: Extract<WeaponEvent, { type: "shot" }> = {
      type: "shot",
      gun: Gun.Rifle,
      millis: 2400,
      from: { x: 1.25, y: -2.5, z: 14 },
      to: { x: 1.25, y: 45.875, z: 14 },
      rays: [{ x: 1.25, y: 45.875, z: 14 }],
      hits: [{ target, distance: 48.375, rays: 1, direction: { x: 0, y: 1, z: 0 } }],
    };

    const packet = new PacketReader(serializeShoot(event, 1234));

    expect(packet.getInt()).toBe(NetworkMessage.Shoot);
    expect(packet.getInt()).toBe(1234);
    expect(packet.getInt()).toBe(Gun.Rifle);
    expect(readVector(packet, DMF)).toEqual(event.from);
    expect(readVector(packet, DMF)).toEqual(event.to);
    expect(packet.getInt()).toBe(1);
    expect(packet.getInt()).toBe(7);
    expect(packet.getInt()).toBe(3);
    expect(packet.getInt()).toBe(Math.trunc(48.375 * DMF));
    expect(packet.getInt()).toBe(1);
    expect(readVector(packet, DNF)).toEqual({ x: 0, y: 1, z: 0 });
    expect(packet.remaining).toBe(0);
  });
});

function readVector(packet: PacketReader, scale: number): { x: number; y: number; z: number } {
  return { x: packet.getInt() / scale, y: packet.getInt() / scale, z: packet.getInt() / scale };
}
