import { describe, expect, it } from "vitest";
import { sauerFormattedMarkup } from "./sauerFormatting";

describe("sauerFormattedMarkup", () => {
  it("renders native saved colors and restores the previous color", () => {
    expect(sauerFormattedMarkup("Frag \fs\f3the enemy\fr for \fs\f1your team\fr."))
      .toBe("Frag <span class=\"sauer-color-red\">the enemy</span> for <span class=\"sauer-color-blue\">your team</span>.");
  });

  it("escapes description text before generating markup", () => {
    expect(sauerFormattedMarkup("<mode> & \fs\f7flag\fr"))
      .toBe("&lt;mode&gt; &amp; <span class=\"sauer-color-yellow\">flag</span>");
  });
});
