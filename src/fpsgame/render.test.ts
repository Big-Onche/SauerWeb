import { describe, expect, it } from "vitest";
import { ClientState, PhysicsState } from "../engine/physics/types";
import { getplayermodelinfo, isTeamMode, playerSkin, renderclient, type RenderClientState } from "./render";

const idle: RenderClientState = {
  state: ClientState.Alive,
  move: 0,
  strafe: 0,
  physicsState: PhysicsState.Floor,
  lastPain: -1000,
};

describe("player rendering policy", () => {
  it("uses the multiplayer-selected player model with the local model as fallback", () => {
    expect(getplayermodelinfo(3, 0)).toEqual({ index: 3, name: "inky" });
    expect(getplayermodelinfo(99, 1)).toEqual({ index: 1, name: "snoutx10k" });
  });

  it("selects native blue ally and red enemy skins in team modes or when teamskins is enabled", () => {
    expect(isTeamMode(2)).toBe(true);
    expect(isTeamMode(3)).toBe(false);
    expect(playerSkin(2, false, "good", "good")).toBe("blueTeam");
    expect(playerSkin(2, false, "good", "evil")).toBe("redTeam");
    expect(playerSkin(0, false, "good", "evil")).toBe("ffa");
    expect(playerSkin(0, true, "good", "evil")).toBe("redTeam");
  });

  it("matches renderclient locomotion and state animation precedence without ragdolls", () => {
    expect(renderclient(idle, 1000)).toBe("idle");
    expect(renderclient({ ...idle, move: 1 }, 1000)).toBe("forward");
    expect(renderclient({ ...idle, strafe: 1 }, 1000)).toBe("left");
    expect(renderclient({ ...idle, physicsState: PhysicsState.Fall, timeInAir: 101 }, 1000)).toBe("jump");
    expect(renderclient({ ...idle, state: ClientState.Lagged }, 1000)).toBe("lag");
    expect(renderclient({ ...idle, state: ClientState.Dead, deadAt: 500 }, 1000)).toBe("dying");
    expect(renderclient({ ...idle, state: ClientState.Dead, deadAt: 0 }, 1001)).toBe("dead");
  });
});
