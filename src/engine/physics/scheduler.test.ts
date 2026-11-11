import { describe, expect, it } from "vitest";
import { PhysicsScheduler } from "./scheduler";

describe("PhysicsScheduler", () => {
  it("matches Sauerbraten's ceil-to-5ms frame scheduling and interpolation", () => {
    const scheduler = new PhysicsScheduler();
    scheduler.reset(100);
    const first = scheduler.schedule(101);
    expect(first).toMatchObject({ steps: 1, stepMilliseconds: 5 });
    expect(first.interpolation).toBeCloseTo(0.2);
    const second = scheduler.schedule(104);
    expect(second).toMatchObject({ steps: 0, stepMilliseconds: 5 });
    expect(second.interpolation).toBeCloseTo(0.8);
    const third = scheduler.schedule(111);
    expect(third).toMatchObject({ steps: 2, stepMilliseconds: 5 });
    expect(third.interpolation).toBeCloseTo(0.2);
  });

  it("uses native integer scaled frame times", () => {
    const scheduler = new PhysicsScheduler();
    scheduler.reset(0);
    expect(scheduler.schedule(5, 50)).toMatchObject({ steps: 3, stepMilliseconds: 2 });
  });
});
