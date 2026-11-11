let guiSkinSequence = 0;

// The native GUI skin is a nine-slice: corners stay fixed while edges and center tile independently.
export function guiSkinMarkup(): string {
  const skinId = guiSkinSequence++;
  const pieces = [
    ["corner top-left", "11 104 12 13"], ["edge top", "23 104 206 13"], ["corner top-right", "229 104 17 13"],
    ["edge left", "11 56 12 48"], ["center", "23 56 206 48"], ["edge right", "229 56 17 48"],
    ["corner bottom-left", "11 104 12 13"], ["edge bottom", "23 104 206 13"], ["corner bottom-right", "229 104 17 13"],
  ];
  const tileSizes: Record<string, [number, number]> = {
    "edge top": [412, 26], "edge left": [24, 96], center: [412, 96], "edge right": [34, 96], "edge bottom": [412, 26],
  };
  return `<div class="gui-skin" aria-hidden="true">${pieces.map(([className, viewBox], index) => {
    const classes = `skin-${className.replaceAll(" ", " skin-")}`;
    const tileSize = tileSizes[className];
    if (tileSize) {
      const patternId = `skin-piece-${skinId}-${index}`;
      return `<svg class="${classes}"><defs><pattern id="${patternId}" width="${tileSize[0]}" height="${tileSize[1]}" ` +
        `patternUnits="userSpaceOnUse"><svg width="${tileSize[0]}" height="${tileSize[1]}" viewBox="${viewBox}" ` +
        `preserveAspectRatio="none"><image href="/api/data/guiskin.png" width="256" height="128" /></svg></pattern></defs>` +
        `<rect width="100%" height="100%" fill="url(#${patternId})" /></svg>`;
    }
    return `<svg class="${classes}" viewBox="${viewBox}" preserveAspectRatio="none">` +
      `<image href="/api/data/guiskin.png" width="256" height="128" /></svg>`;
  }).join("")}</div>`;
}
