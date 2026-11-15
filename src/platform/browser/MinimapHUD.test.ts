import { describe, expect, it } from "vitest";
import { minimapLayout, minimapRadiusFromGeometry, needMinimap, radarDirection } from "./MinimapHUD";

describe("MinimapHUD", () => {
  it("uses the native mode visibility rules", () => {
    expect(needMinimap(0)).toBe(false);
    expect(needMinimap(12)).toBe(true);
    expect(needMinimap(16)).toBe(true);
    expect(needMinimap(19)).toBe(true);
  });

  it("rotates Sauer world offsets by the camera yaw", () => {
    expect(radarDirection({ x: 100, y: 100, z: 0 }, { x: 100, y: 200, z: 0 }, 0, 100, 0.9)).toEqual({ x: 0, y: -0.9 });
    const east = radarDirection({ x: 100, y: 100, z: 0 }, { x: 200, y: 100, z: 0 }, 90, 100, 0.9);
    expect(east.x).toBeCloseTo(0);
    expect(east.y).toBeCloseTo(0.9);
  });

  it("clips distant markers at the radar edge", () => {
    const direction = radarDirection({ x: 0, y: 0, z: 0 }, { x: 300, y: 400, z: 0 }, 0, 100, 0.8);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(0.8);
  });

  it("derives the square native minimap radius from Babylon geometry axes", () => {
    const radius = minimapRadiusFromGeometry([{ positions: [-20, 50, 10, 80, -10, 210] }], 1024);
    expect(radius).toBe(100);
    expect(minimapRadiusFromGeometry([], 1024)).toBe(512);
  });

  it("centers only the blip field on the mobile crosshair", () => {
    expect(minimapLayout(800, 400, true)).toEqual({ x: 280, y: 80, size: 240, overlay: false });
    expect(minimapLayout(800, 400, false)).toEqual({ x: 690, y: 10, size: 100, overlay: true });
  });
});
