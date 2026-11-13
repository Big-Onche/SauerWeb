import { describe, expect, it } from "vitest";
import { deviceViewAngles } from "./PhysicsInput";

describe("device orientation camera mapping", () => {
  it("uses an upright portrait orientation as the neutral view", () => {
    const view = deviceViewAngles(0, 90, 0);
    expect(view.yaw).toBeCloseTo(0, 6);
    expect(view.pitch).toBeCloseTo(0, 6);
    expect(view.horizontal).toBeCloseTo(1, 6);
  });

  it("maps the browser compass direction into the natural camera yaw direction", () => {
    expect(deviceViewAngles(-30, 90, 0).yaw).toBeCloseTo(30, 6);
    expect(deviceViewAngles(30, 90, 0).yaw).toBeCloseTo(-30, 6);
  });

  it("maps upward and downward tilts without coupling them into yaw", () => {
    const upward = deviceViewAngles(25, 110, 0), downward = deviceViewAngles(25, 70, 0);
    expect(upward.pitch).toBeCloseTo(20, 6);
    expect(downward.pitch).toBeCloseTo(-20, 6);
    expect(upward.yaw).toBeCloseTo(downward.yaw, 6);
  });

  it("reports the vertical singularity so callers can retain stable yaw", () => {
    expect(deviceViewAngles(120, 0, 0).horizontal).toBeCloseTo(0, 6);
    expect(deviceViewAngles(120, 180, 0).horizontal).toBeCloseTo(0, 6);
  });
});
