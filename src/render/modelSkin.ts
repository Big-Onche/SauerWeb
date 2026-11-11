import type { MapModelSkin } from "../assets/types";

function normalizeMeshName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// MD5 mesh files identify parts through shader names, while Sauerbraten's md5skin command uses logical mesh names.
// Match both forms so, for example, cc_body maps to body and Fixit's unnamed body shader does not inherit Head.
export function selectModelSkin(skins: readonly MapModelSkin[], meshName: string): MapModelSkin | undefined {
  const wildcard = skins.find((skin) => skin.mesh === "*");
  const named = skins.filter((skin) => skin.mesh !== "*");
  const normalizedMesh = normalizeMeshName(meshName);
  const exact = named.find((skin) => normalizeMeshName(skin.mesh) === normalizedMesh);
  if (exact) return exact;

  const contained = named.find((skin) => {
    const part = normalizeMeshName(skin.mesh);
    return part.length >= 3 && (normalizedMesh.includes(part) || part.includes(normalizedMesh));
  });
  if (contained) return contained;

  const head = named.find((skin) => normalizeMeshName(skin.mesh) === "head");
  const body = named.find((skin) => normalizeMeshName(skin.mesh) === "body");
  if (head && body) return normalizedMesh.includes("head") ? head : body;

  return wildcard ?? skins[0];
}
