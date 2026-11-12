import { describe, expect, it } from "vitest";
import { WaypointSystem } from "./waypoint";

describe("WaypointSystem", () => {
  it("round-trips the native OWPT layout and preserves one-based links", () => {
    const source = new WaypointSystem();
    const first = source.addwaypoint({ x: 1, y: 2, z: 3 });
    const second = source.addwaypoint({ x: 10, y: 20, z: 30 });
    source.linkwaypoint(first, second);
    const restored = new WaypointSystem();
    restored.parse(source.savewaypoints());
    expect(restored.waypoints).toEqual(source.waypoints);
  });

  it("returns native reverse routes from goal toward the start", () => {
    const system = new WaypointSystem();
    const first = system.addwaypoint({ x: 0, y: 0, z: 0 });
    const second = system.addwaypoint({ x: 16, y: 0, z: 0 });
    const third = system.addwaypoint({ x: 32, y: 0, z: 0 });
    system.linkwaypoint(first, second);
    system.linkwaypoint(second, third);
    expect(system.route(first, third)).toEqual([third, second]);
  });
});
