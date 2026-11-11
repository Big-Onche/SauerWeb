import { describe, expect, it } from "vitest";
import { rewriteFogDistanceForSauer } from "./SauerFogShader";

describe("Sauer fog shader", () => {
  it("uses forward view depth instead of Babylon's radial distance", () => {
    const shader = "before float fogDistance=length(vFogDistance); after";

    expect(rewriteFogDistanceForSauer(shader)).toBe("before float fogDistance=abs(vFogDistance.z); after");
  });

  it("can be installed more than once", () => {
    const shader = "float fogDistance=abs(vFogDistance.z);";

    expect(rewriteFogDistanceForSauer(shader)).toBe(shader);
  });

  it("fails clearly if Babylon changes its fog include", () => {
    expect(() => rewriteFogDistanceForSauer("unknown fog shader")).toThrow(/layout has changed/);
  });
});
