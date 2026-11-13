import { describe, expect, it } from "vitest";
import { DEFAULT_MOVEMENT_BINDINGS, keyBindingLabel, keyForEvent, sanitizeMovementBindings } from "./KeyBindings";

describe("movement key bindings", () => {
  it("uses layout-aware WASD defaults", () => {
    expect(DEFAULT_MOVEMENT_BINDINGS).toMatchObject({ forward: "w", backward: "s", left: "a", right: "d" });
  });

  it("keeps valid saved bindings and fills missing values with defaults", () => {
    expect(sanitizeMovementBindings({ forward: "ArrowUp", jump: "Enter" })).toEqual({
      forward: "ArrowUp", backward: "s", left: "a", right: "d", jump: "Enter",
    });
  });

  it("migrates physical codes saved by the previous implementation", () => {
    expect(sanitizeMovementBindings({ forward: "KeyZ", left: "KeyQ", jump: "Space" })).toMatchObject({ forward: "z", left: "q", jump: " " });
  });

  it("uses the character produced by the active keyboard layout", () => {
    expect(keyForEvent({ key: "z", code: "KeyW" } as KeyboardEvent)).toBe("z");
    expect(keyForEvent({ key: "W" } as KeyboardEvent)).toBe("w");
  });

  it("formats key values for the options menu", () => {
    expect(keyBindingLabel("w")).toBe("W");
    expect(keyBindingLabel(" ")).toBe("Space");
    expect(keyBindingLabel("ArrowUp")).toBe("Arrow Up");
  });
});
