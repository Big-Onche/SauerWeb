import { describe, expect, it } from "vitest";
import { MAP_MENU_PAGES, mapMenuPagesForMode } from "./menuData";

describe("Sauerbraten map menu data", () => {
  it("preserves the eleven tab pages from menus.cfg", () => {
    expect(MAP_MENU_PAGES.map((page) => page.id)).toEqual([
      "ffa-1", "ffa-2", "ffa-3", "ffa-4", "capture-1", "capture-2", "capture-3", "ctf-1", "ctf-2", "ctf-3", "concept",
    ]);
  });

  it("includes representative maps in their native groups", () => {
    expect(MAP_MENU_PAGES[0].columns[0]).toContain("aard3c");
    expect(MAP_MENU_PAGES[4].columns.flat()).toContain("capture_night");
    expect(MAP_MENU_PAGES[7].columns.flat()).toContain("ctf_suite");
    expect(MAP_MENU_PAGES[10].columns[0]).toContain("sauerbraten");
  });

  it("exposes every map tab for deathmatch, team, and editing modes", () => {
    for (let mode = 0; mode <= 8; mode++) expect(mapMenuPagesForMode(mode)).toEqual(MAP_MENU_PAGES);
  });

  it("keeps objective and editing map groups scoped to compatible modes", () => {
    expect(mapMenuPagesForMode(9).every((page) => page.category === "capture")).toBe(true);
    expect(mapMenuPagesForMode(11).every((page) => page.category === "ctf")).toBe(true);
  });
});
