import { describe, expect, it } from "vitest";
import { stripSauerFormatting } from "./GameConsole";

describe("Sauerbraten console formatting", () => {
  it("removes Cube color and stack escapes while preserving the message", () => {
    expect(stripSauerFormatting("\f2you\f7 fragged \fs\f8[team]\fr enemy")).toBe("you fragged [team] enemy");
  });

  it("removes bracketed formatting escapes and control characters", () => {
    expect(stripSauerFormatting("before\f[1,2,3]after\u0007")).toBe("beforeafter");
  });
});
