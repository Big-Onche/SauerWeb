import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import "@babylonjs/core/Shaders/ShadersInclude/fogFragmentDeclaration";

const BABYLON_FOG_DISTANCE = "float fogDistance=length(vFogDistance);";
const SAUER_FOG_DISTANCE = "float fogDistance=abs(vFogDistance.z);";
const CUSTOM_RADIAL_FOG_DISTANCE = "vFogDistance = length(cameraVector);";
const CUSTOM_SAUER_FOG_DISTANCE = "vFogDistance = abs((view * worldPosition).z);";

/**
 * Sauerbraten applies linear fog using camera-forward view depth. Babylon's
 * default shader instead uses radial distance from the camera, which is longer
 * toward the sides of the view and consequently makes the same fog look denser.
 */
export function rewriteFogDistanceForSauer(shader: string): string {
  if (shader.includes(SAUER_FOG_DISTANCE)) return shader;
  if (!shader.includes(BABYLON_FOG_DISTANCE)) {
    throw new Error("Babylon's fog shader layout has changed; Sauer fog distance could not be installed.");
  }
  return shader.replace(BABYLON_FOG_DISTANCE, SAUER_FOG_DISTANCE);
}

export function rewriteCustomFogDistanceForSauer(shader: string): string {
  if (shader.includes(CUSTOM_SAUER_FOG_DISTANCE)) return shader;
  if (!shader.includes(CUSTOM_RADIAL_FOG_DISTANCE)) {
    throw new Error("The custom material's fog shader layout has changed; Sauer fog distance could not be installed.");
  }
  return shader.replace(CUSTOM_RADIAL_FOG_DISTANCE, CUSTOM_SAUER_FOG_DISTANCE);
}

export function installSauerFogDistance(): void {
  const shader = ShaderStore.IncludesShadersStore.fogFragmentDeclaration;
  if (!shader) throw new Error("Babylon's fog fragment declaration is unavailable.");
  ShaderStore.IncludesShadersStore.fogFragmentDeclaration = rewriteFogDistanceForSauer(shader);
}
