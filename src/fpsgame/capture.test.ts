import { describe, expect, it } from "vitest";
import { ClientState } from "../engine/physics/types";
import { CaptureClientMode, OCCUPYENEMYLIMIT, OCCUPYNEUTRALLIMIT, type CapturePlayer } from "./capture";
import { Gun } from "./weapon/WeaponDefinitions";

function entity(x = 0, ammo = Gun.Shotgun, tag = 1) {
  return { typeName: "base", position: { x, y: 0, z: 0 }, attributes: [ammo, tag] };
}

function player(clientNumber: number, team: string, x = 0): CapturePlayer {
  return {
    clientNumber, team, state: ClientState.Alive, position: { x, y: 0, z: 14 }, eyeHeight: 14,
    health: 100, maxHealth: 100, armour: 0, armourType: 0, ammo: new Int32Array(12),
  };
}

describe("CaptureClientMode local authority", () => {
  it("uses native neutralization and capture thresholds and pauses while contested", () => {
    const mode = new CaptureClientMode(), good = player(0, "good"), evil = player(1, "evil");
    mode.setup([entity(), entity(1000, Gun.Chaingun, 2)]);
    mode.initializeLocal(0);
    for (let second = 1; second <= OCCUPYNEUTRALLIMIT / 2; second++) mode.updateLocal([good], false, second * 1000);
    expect(mode.bases[0]).toMatchObject({ owner: "good", enemy: "", converted: 0 });

    mode.updateLocal([good, evil], false, 8000);
    expect(mode.bases[0]).toMatchObject({ owner: "good", enemy: "evil", converted: 0 });
    mode.updateLocal([good, evil], false, 9000);
    expect(mode.bases[0].converted).toBe(0);

    for (let second = 10; second < 10 + OCCUPYENEMYLIMIT / 2; second++) mode.updateLocal([evil], false, second * 1000);
    expect(mode.bases[0]).toMatchObject({ owner: "", enemy: "evil", converted: 0 });
    for (let second = 24; second < 24 + OCCUPYNEUTRALLIMIT / 2; second++) mode.updateLocal([evil], false, second * 1000);
    expect(mode.bases[0]).toMatchObject({ owner: "evil", enemy: "", converted: 0 });
  });

  it("scores, generates and replenishes native ammo amounts", () => {
    const mode = new CaptureClientMode(), good = player(0, "good");
    mode.setup([entity(), entity(1000, Gun.Chaingun, 2)]);
    mode.initializeLocal(0);
    for (let second = 1; second <= 7; second++) mode.updateLocal([good], false, second * 1000);
    good.position.x = 200;
    mode.updateLocal([good], false, 17_000);
    expect(mode.scores.get("good")).toBe(1);
    mode.updateLocal([good], false, 22_000);
    expect(mode.bases[0].ammo).toBe(1);
    good.position.x = 0;
    expect(mode.replenishammo(good)).toBe(mode.bases[0]);
    expect(good.ammo[Gun.Shotgun]).toBe(10);
    expect(mode.bases[0].ammo).toBe(0);
  });

  it("regenerates health, green armour and base ammo every second", () => {
    const mode = new CaptureClientMode(), good = player(0, "good");
    mode.setup([entity(), entity(1000, Gun.Chaingun, 2)]);
    mode.initializeLocal(0);
    for (let second = 1; second <= 7; second++) mode.updateLocal([good], true, second * 1000);
    good.health = 60;
    good.armour = 75;
    good.armourType = 2;
    good.ammo[Gun.Shotgun] = 1;
    mode.updateLocal([good], true, 8000);
    expect(good).toMatchObject({ health: 70, armour: 10, armourType: 1 });
    expect(good.ammo[Gun.Shotgun]).toBe(3);
  });

  it("announces the native all-bases victory on the update after capture", () => {
    const mode = new CaptureClientMode(), good = player(0, "good"), events: string[] = [];
    mode.setup([entity()]);
    mode.initializeLocal(0);
    for (let second = 1; second <= 7; second++) mode.updateLocal([good], false, second * 1000,
      (event) => events.push(event.type));
    expect(events).not.toContain("victory");
    mode.updateLocal([good], false, 8000, (event) => events.push(event.type));
    expect(events).toContain("victory");
    expect(mode.scores.get("good")).toBe(10_000);
  });
});
