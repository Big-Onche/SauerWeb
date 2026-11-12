import { describe, expect, it } from "vitest";
import { applyNetworkPosition, createNetworkInterpolation, interpolateNetworkEntity, resetNetworkInterpolation } from "./networkInterpolation";

function entity(position = { x: 0, y: 0, z: 14 }, yaw = 0) {
  return { position: { ...position }, yaw, pitch: 0, roll: 0, interpolation: createNetworkInterpolation(position) };
}

describe("Sauerbraten network player interpolation", () => {
  it("smooths packet transforms over the native 75 millisecond window", () => {
    const player = entity();
    applyNetworkPosition(player, player.position, 0, 0, 0, 0);
    applyNetworkPosition(player, { x: 12, y: 0, z: 14 }, 20, 10, 4, 100);

    interpolateNetworkEntity(player, 100);
    expect(player.position.x).toBe(0);
    expect(player.yaw).toBe(0);
    interpolateNetworkEntity(player, 137.5);
    expect(player.position.x).toBeCloseTo(6);
    expect(player.yaw).toBeCloseTo(10);
    interpolateNetworkEntity(player, 175);
    expect(player.position.x).toBe(12);
    expect(player.pitch).toBe(10);
  });

  it("takes the shortest path across the yaw wrap", () => {
    const player = entity({ x: 0, y: 0, z: 14 }, 350);
    applyNetworkPosition(player, player.position, 350, 0, 0, 0);
    applyNetworkPosition(player, player.position, 10, 0, 0, 100);

    interpolateNetworkEntity(player, 137.5);
    expect(player.yaw).toBeCloseTo(0);
  });

  it("predicts packet position every render frame from velocity and falling like predictplayer", () => {
    const player = { ...entity(), velocity: { x: 20, y: 0, z: 5 }, falling: { x: 0, y: 0, z: -10 } };
    applyNetworkPosition(player, player.position, 0, 0, 0, 100);

    interpolateNetworkEntity(player, 125);
    expect(player.position).toEqual({ x: 0.5, y: 0, z: 13.875 });
    interpolateNetworkEntity(player, 150);
    expect(player.position).toEqual({ x: 1, y: 0, z: 13.75 });
  });

  it("snaps large corrections and the first packet after a respawn reset", () => {
    const player = entity();
    applyNetworkPosition(player, player.position, 0, 0, 0, 0);
    applyNetworkPosition(player, { x: 32, y: 0, z: 14 }, 90, 0, 0, 100);
    expect(player.position.x).toBe(32);

    resetNetworkInterpolation(player);
    applyNetworkPosition(player, { x: 4, y: 8, z: 14 }, 180, 0, 0, 200);
    expect(player.position).toEqual({ x: 4, y: 8, z: 14 });
    expect(player.yaw).toBe(180);
  });
});
