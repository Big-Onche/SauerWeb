import type { RegisteredMapEntity, Vec3 } from "../engine/octa";

export const MAXWAYPOINTS = 0xFFFF - 2;
export const MAXWAYPOINTLINKS = 6;
export const WAYPOINTRADIUS = 16;
export const MINWPDIST = 4;
export const CLOSEDIST = 32;
export const FARDIST = 128;
export const JUMPMIN = 4;
export const JUMPMAX = 32;
export const SIGHTMIN = 64;
export const SIGHTMAX = 1024;
export const VIEWMIN = 90;
export const VIEWMAX = 180;

export interface Waypoint {
  o: Vec3;
  weight: number;
  links: number[];
}

export interface RouteOptions {
  previousNodes?: readonly number[];
  avoidedNodes?: ReadonlySet<number>;
  retries?: number;
}

export interface WaypointSelection {
  min: Vec3;
  max: Vec3;
}

// Original: src/fpsgame/waypoint.cpp, src/fpsgame/ai.h
// Functions: closestwaypoint(), findwaypointswithin(), route(), loadwaypoints(), savewaypoints(), waypoint editing commands
// The zero entry is deliberately retained: native waypoint indices are one-based and serialized links refer to those indices.
export class WaypointSystem {
  readonly waypoints: Waypoint[] = [];
  loadedWaypoints = "";
  dropWaypoints = false;
  showWaypoints = false;
  showWaypointsRadius = 200;

  constructor(private readonly weightAt: (position: Vec3) => number = () => 1) {
    this.clearwaypoints();
  }

  iswaypoint(index: number): boolean {
    return index > 0 && index < this.waypoints.length;
  }

  clearwaypoints(full = false): void {
    this.waypoints.length = 0;
    this.waypoints.push({ o: { x: 0, y: 0, z: 0 }, weight: 1, links: [] });
    if (full) {
      this.loadedWaypoints = "";
      this.dropWaypoints = false;
    }
  }

  seedwaypoints(entities: readonly RegisteredMapEntity[]): void {
    if (this.waypoints.length > 1) return;
    for (const entity of entities) {
      if (entity.type === 3 || entity.type === 19 || entity.type === 23 || entity.type === 24 || entity.type === 31 ||
          entity.type >= 8 && entity.type <= 18) this.addwaypoint(entity.position);
    }
  }

  addwaypoint(o: Vec3, weight = this.weightAt(o)): number {
    if (this.waypoints.length > MAXWAYPOINTS) return -1;
    this.waypoints.push({ o: { ...o }, weight, links: [] });
    return this.waypoints.length - 1;
  }

  linkwaypoint(from: number, to: number, random: () => number = Math.random): void {
    if (!this.iswaypoint(from) || !this.iswaypoint(to)) return;
    const links = this.waypoints[from].links;
    if (links.includes(to)) return;
    if (links.length < MAXWAYPOINTLINKS) links.push(to);
    else links[Math.floor(random() * MAXWAYPOINTLINKS)] = to;
  }

  inferwaypoints(lastNode: number, from: Vec3, to: Vec3, timeInAir = 0, minimumDistance = CLOSEDIST): number {
    if (this.waypoints.length <= 1) this.addwaypoint({ x: 0, y: 0, z: 0 });
    let fromNode = this.closestwaypoint(from, minimumDistance, false);
    let toNode = this.closestwaypoint(to, minimumDistance, false);
    if (!this.iswaypoint(fromNode)) fromNode = this.addwaypoint(from);
    if (!this.iswaypoint(toNode)) toNode = this.addwaypoint(to);
    if (lastNode !== fromNode && this.iswaypoint(lastNode)) this.linkwaypoint(lastNode, fromNode);
    if (fromNode !== toNode && this.iswaypoint(fromNode) && this.iswaypoint(toNode)) {
      this.linkwaypoint(fromNode, toNode);
      if (!timeInAir) this.linkwaypoint(toNode, fromNode);
    }
    return toNode;
  }

  closestwaypoint(position: Vec3, minimumDistance: number, requireLinks: boolean): number {
    let closest = -1, closestDistance = minimumDistance * minimumDistance;
    for (let index = 1; index < this.waypoints.length; index++) {
      const waypoint = this.waypoints[index];
      if (requireLinks && !waypoint.links.length) continue;
      const distance = squaredDistance(position, waypoint.o);
      if (distance <= closestDistance) { closest = index; closestDistance = distance; }
    }
    return closest;
  }

  findwaypointswithin(position: Vec3, minimumDistance: number, maximumDistance: number): number[] {
    const minimumSquared = minimumDistance * minimumDistance, maximumSquared = maximumDistance * maximumDistance;
    const results: number[] = [];
    for (let index = 1; index < this.waypoints.length; index++) {
      const distance = squaredDistance(position, this.waypoints[index].o);
      if (distance >= minimumSquared && distance <= maximumSquared) results.push(index);
    }
    return results;
  }

  route(node: number, goal: number, options: RouteOptions = {}): number[] {
    if (!this.iswaypoint(node) || !this.iswaypoint(goal) || node === goal || !this.waypoints[node].links.length) return [];
    const retries = options.retries ?? 0;
    const blocked = new Set<number>();
    if (retries <= 1) for (const previous of options.previousNodes ?? []) if (previous !== node && this.iswaypoint(previous)) blocked.add(previous);
    if (retries <= 0) for (const avoided of options.avoidedNodes ?? []) {
      if (avoided !== node && avoided !== goal && !this.waypoints[node].links.includes(avoided) && !this.waypoints[goal].links.includes(avoided)) {
        blocked.add(avoided);
      }
    }
    const open = [node], cameFrom = new Int32Array(this.waypoints.length), score = new Float64Array(this.waypoints.length);
    const estimate = new Float64Array(this.waypoints.length), visited = new Uint8Array(this.waypoints.length);
    score.fill(Number.POSITIVE_INFINITY);
    estimate.fill(Number.POSITIVE_INFINITY);
    score[node] = estimate[node] = 0;
    let lowest = -1;
    while (open.length) {
      let bestAt = 0;
      for (let index = 1; index < open.length; index++) if (score[open[index]] + estimate[open[index]] < score[open[bestAt]] + estimate[open[bestAt]]) bestAt = index;
      const current = open.splice(bestAt, 1)[0];
      if (current === goal) { lowest = goal; break; }
      visited[current] = 1;
      for (const link of this.waypoints[current].links) {
        if (!this.iswaypoint(link) || blocked.has(link) || visited[link] || link !== goal && !this.waypoints[link].links.length) continue;
        const weight = Math.max(this.waypoints[link].weight, 1);
        const candidate = score[current] + distance(this.waypoints[current].o, this.waypoints[link].o) * weight;
        if (candidate >= score[link]) continue;
        cameFrom[link] = current;
        score[link] = candidate;
        estimate[link] = distance(this.waypoints[link].o, this.waypoints[goal].o) * weight;
        if (estimate[link] <= WAYPOINTRADIUS * 4 && (lowest < 0 || estimate[link] <= estimate[lowest])) lowest = link;
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

  async loadwaypoints(mapName: string, force = false): Promise<boolean> {
    const path = `packages/base/${mapName}.wpt`;
    if (!force && (this.waypoints.length > 1 || this.loadedWaypoints === path)) return true;
    const response = await fetch(`/api/${path}`);
    if (!response.ok) return false;
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    this.parse(bytes);
    this.loadedWaypoints = path;
    return true;
  }

  parse(bytes: Uint8Array): void {
    if (bytes.length < 6 || String.fromCharCode(...bytes.subarray(0, 4)) !== "OWPT") throw new Error("Invalid Sauerbraten waypoint file.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 4;
    const count = view.getUint16(offset, true); offset += 2;
    this.clearwaypoints();
    for (let index = 0; index < count && offset + 13 <= bytes.length; index++) {
      const o = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
      offset += 12;
      const linkCount = bytes[offset++], links: number[] = [];
      for (let link = 0; link < linkCount && offset + 2 <= bytes.length; link++, offset += 2) {
        const target = view.getUint16(offset, true);
        if (target && links.length < MAXWAYPOINTLINKS) links.push(target);
      }
      this.waypoints.push({ o, weight: this.weightAt(o), links });
    }
    this.cleanwaypoints();
  }

  savewaypoints(): Uint8Array {
    const size = 6 + this.waypoints.slice(1).reduce((total, waypoint) => total + 13 + Math.min(waypoint.links.length, MAXWAYPOINTLINKS) * 2, 0);
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    bytes.set([0x4F, 0x57, 0x50, 0x54]);
    view.setUint16(4, this.waypoints.length - 1, true);
    let offset = 6;
    for (const waypoint of this.waypoints.slice(1)) {
      view.setFloat32(offset, waypoint.o.x, true); view.setFloat32(offset + 4, waypoint.o.y, true); view.setFloat32(offset + 8, waypoint.o.z, true);
      offset += 12;
      const links = waypoint.links.slice(0, MAXWAYPOINTLINKS);
      bytes[offset++] = links.length;
      for (const link of links) { view.setUint16(offset, link, true); offset += 2; }
    }
    return bytes;
  }

  delselwaypoints(selection: WaypointSelection): number {
    return this.removeWhere((waypoint) => waypoint.o.x >= selection.min.x && waypoint.o.x <= selection.max.x &&
      waypoint.o.y >= selection.min.y && waypoint.o.y <= selection.max.y && waypoint.o.z >= selection.min.z && waypoint.o.z <= selection.max.z);
  }

  movewaypoints(delta: Vec3, worldSize: number): number {
    for (const waypoint of this.waypoints.slice(1)) {
      waypoint.o.x += delta.x; waypoint.o.y += delta.y; waypoint.o.z += delta.z;
    }
    return this.removeWhere((waypoint) => waypoint.o.x < 0 || waypoint.o.y < 0 || waypoint.o.z < 0 ||
      waypoint.o.x >= worldSize || waypoint.o.y >= worldSize || waypoint.o.z >= worldSize);
  }

  private cleanwaypoints(): void {
    this.removeWhere((waypoint) => !Number.isFinite(waypoint.o.x + waypoint.o.y + waypoint.o.z));
  }

  private removeWhere(predicate: (waypoint: Waypoint) => boolean): number {
    const remap = new Uint16Array(this.waypoints.length), kept = [this.waypoints[0]];
    let removed = 0;
    for (let index = 1; index < this.waypoints.length; index++) {
      if (predicate(this.waypoints[index])) { removed++; continue; }
      remap[index] = kept.length;
      kept.push(this.waypoints[index]);
    }
    for (const waypoint of kept.slice(1)) waypoint.links = waypoint.links.map((link) => remap[link]).filter(Boolean).slice(0, MAXWAYPOINTLINKS);
    this.waypoints.splice(0, this.waypoints.length, ...kept);
    return removed;
  }
}

function squaredDistance(left: Vec3, right: Vec3): number {
  const x = left.x - right.x, y = left.y - right.y, z = left.z - right.z;
  return x * x + y * y + z * z;
}

function distance(left: Vec3, right: Vec3): number { return Math.sqrt(squaredDistance(left, right)); }
