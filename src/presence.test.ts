import { describe, expect, it } from "vitest";
import { onlinePlayersLabel } from "./presence";

describe("onlinePlayersLabel", () => {
  it("uses the singular form for zero or one player and the plural form above one", () => {
    expect(onlinePlayersLabel(0)).toBe("0 player on SauerWeb right now!");
    expect(onlinePlayersLabel(1)).toBe("1 player on SauerWeb right now!");
    expect(onlinePlayersLabel(2)).toBe("2 players on SauerWeb right now!");
  });
});
