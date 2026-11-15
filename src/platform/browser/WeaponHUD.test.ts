import { describe, expect, it } from "vitest";
import { mobilePlayerHudTransform } from "./WeaponHUD";

describe("WeaponHUD mobile layout", () => {
  it("centers the native status strip with its icons near the lower frame", () => {
    const transform = mobilePlayerHudTransform(800, 400, 1);
    expect(400 - (1650 + 120 + transform.y) * transform.scale).toBeCloseTo(8);
    expect((760 + transform.x) * transform.scale).toBeCloseTo(400);
  });

  it("keeps responsive bottom padding when the mobile HUD scale changes", () => {
    for (const hudScale of [0.75, 1, 1.3]) {
      const transform = mobilePlayerHudTransform(1000, 500, hudScale);
      expect(500 - (1650 + 120 + transform.y) * transform.scale).toBeCloseTo(10);
    }
  });
});
