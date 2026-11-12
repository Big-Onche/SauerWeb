import { describe, expect, it } from "vitest";
import { SIGHTMAX, WaypointSystem, type RouteOptions, type Waypoint } from "./waypoint";

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

  it("matches linear nearest and range queries after building and invalidating the spatial index", () => {
    const system = waypointFixture(500);
    let seed = 0xA11CE;
    const random = () => {
      seed = seed * 1664525 + 1013904223 >>> 0;
      return seed / 0x100000000;
    };
    for (let sample = 0; sample < 200; sample++) {
      const position = { x: random() * 2048, y: random() * 2048, z: random() * 256 };
      const radius = 16 + random() * SIGHTMAX;
      for (const requireLinks of [false, true]) {
        expect(system.closestwaypoint(position, radius, requireLinks)).toBe(linearClosest(system.waypoints, position, radius, requireLinks));
      }
      const minimum = random() * radius;
      expect(system.findwaypointswithin(position, minimum, radius)).toEqual(linearWithin(system.waypoints, position, minimum, radius));
    }

    system.addwaypoint({ x: 2047, y: 2047, z: 255 });
    expect(system.closestwaypoint({ x: 2047, y: 2047, z: 255 }, 1, false)).toBe(system.waypoints.length - 1);
  });

  it("keeps stable native route selection while reusing heap scratch buffers", () => {
    const system = waypointFixture(240);
    const avoided = new Set([17, 31, 97]);
    const options: RouteOptions[] = [{}, { previousNodes: [3, 9, 27], retries: 0 }, { avoidedNodes: avoided, retries: 0 },
      { previousNodes: [8, 16], avoidedNodes: avoided, retries: 1 }, { retries: 2 }];
    for (let start = 1; start < 80; start += 7) for (let goal = 100; goal < 220; goal += 11) for (const option of options) {
      expect(system.route(start, goal, option)).toEqual(linearRoute(system.waypoints, start, goal, option));
    }
  });
});

function waypointFixture(count: number): WaypointSystem {
  const system = new WaypointSystem();
  for (let index = 1; index <= count; index++) {
    const node = system.addwaypoint({ x: index * 83 % 2048, y: index * 197 % 2048, z: index * 29 % 256 }, 1 + index % 5);
    for (const offset of [1, 7, 19]) if (node - offset > 0) system.linkwaypoint(node - offset, node, () => 0);
  }
  return system;
}

function linearClosest(waypoints: readonly Waypoint[], position: Waypoint["o"], minimumDistance: number, requireLinks: boolean): number {
  let closest = -1, closestDistance = minimumDistance * minimumDistance;
  for (let index = 1; index < waypoints.length; index++) {
    if (requireLinks && !waypoints[index].links.length) continue;
    const candidateDistance = squaredDistance(position, waypoints[index].o);
    if (candidateDistance <= closestDistance) { closest = index; closestDistance = candidateDistance; }
  }
  return closest;
}

function linearWithin(waypoints: readonly Waypoint[], position: Waypoint["o"], minimumDistance: number, maximumDistance: number): number[] {
  const minimumSquared = minimumDistance * minimumDistance, maximumSquared = maximumDistance * maximumDistance, result: number[] = [];
  for (let index = 1; index < waypoints.length; index++) {
    const candidateDistance = squaredDistance(position, waypoints[index].o);
    if (candidateDistance >= minimumSquared && candidateDistance <= maximumSquared) result.push(index);
  }
  return result;
}

function linearRoute(waypoints: readonly Waypoint[], node: number, goal: number, options: RouteOptions): number[] {
  if (node <= 0 || goal <= 0 || node >= waypoints.length || goal >= waypoints.length || node === goal || !waypoints[node].links.length) return [];
  const retries = options.retries ?? 0, blocked = new Set<number>();
  if (retries <= 1) for (const previous of options.previousNodes ?? []) if (previous !== node && previous > 0 && previous < waypoints.length) {
    blocked.add(previous);
  }
  if (retries <= 0) for (const avoided of options.avoidedNodes ?? []) {
    if (avoided !== node && avoided !== goal && !waypoints[node].links.includes(avoided) && !waypoints[goal].links.includes(avoided)) {
      blocked.add(avoided);
    }
  }
  const open = [node], cameFrom = new Int32Array(waypoints.length), score = new Float64Array(waypoints.length);
  const estimate = new Float64Array(waypoints.length), visited = new Uint8Array(waypoints.length);
  score.fill(Number.POSITIVE_INFINITY);
  estimate.fill(Number.POSITIVE_INFINITY);
  score[node] = estimate[node] = 0;
  let lowest = -1;
  while (open.length) {
    let bestAt = 0;
    for (let index = 1; index < open.length; index++) {
      if (score[open[index]] + estimate[open[index]] < score[open[bestAt]] + estimate[open[bestAt]]) bestAt = index;
    }
    const current = open.splice(bestAt, 1)[0];
    if (current === goal) { lowest = goal; break; }
    visited[current] = 1;
    for (const link of waypoints[current].links) {
      if (link <= 0 || link >= waypoints.length || blocked.has(link) || visited[link] || link !== goal && !waypoints[link].links.length) continue;
      const weight = Math.max(waypoints[link].weight, 1);
      const candidate = score[current] + distance(waypoints[current].o, waypoints[link].o) * weight;
      if (candidate >= score[link]) continue;
      cameFrom[link] = current;
      score[link] = candidate;
      estimate[link] = distance(waypoints[link].o, waypoints[goal].o) * weight;
      if (estimate[link] <= 64 && (lowest < 0 || estimate[link] <= estimate[lowest])) lowest = link;
      if (!open.includes(link)) open.push(link);
    }
  }
  const result: number[] = [];
  if (lowest > 0) for (let current = lowest; current > 0 && current !== node; current = cameFrom[current]) {
    result.push(current);
    if (!cameFrom[current]) break;
  }
  return result;
}

function squaredDistance(left: Waypoint["o"], right: Waypoint["o"]): number {
  const x = left.x - right.x, y = left.y - right.y, z = left.z - right.z;
  return x * x + y * y + z * z;
}

function distance(left: Waypoint["o"], right: Waypoint["o"]): number {
  return Math.sqrt(squaredDistance(left, right));
}
