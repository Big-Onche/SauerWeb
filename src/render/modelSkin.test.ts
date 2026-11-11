import { describe, expect, it } from "vitest";
import type { MapModelSkin } from "../assets/types";
import { selectModelSkin } from "./modelSkin";

function skin(mesh: string): MapModelSkin {
  return { mesh, diffusePath: `${mesh}.png` };
}

describe("selectModelSkin", () => {
  it("maps Captain Cannon shader names to the matching body parts", () => {
    const skins = [skin("head"), skin("body")];
    expect(selectModelSkin(skins, "cc_head")?.mesh).toBe("head");
    expect(selectModelSkin(skins, "cc_body")?.mesh).toBe("body");
  });

  it("maps Mr Fixit's shader names without applying Head to the body", () => {
    const skins = [skin("Head"), skin("Body")];
    expect(selectModelSkin(skins, "fixitheadskin")?.mesh).toBe("Head");
    expect(selectModelSkin(skins, "fixitskinac")?.mesh).toBe("Body");
  });

  it("preserves wildcard and single-skin fallbacks", () => {
    expect(selectModelSkin([skin("*")], "mesh")?.mesh).toBe("*");
    expect(selectModelSkin([skin("only")], "unrelated")?.mesh).toBe("only");
  });
});
