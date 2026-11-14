import type { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

export interface ProjectedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  minW: number;
}

export interface PixelScissor {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_CLIP_W = 1e-4;
const clipX = new Float64Array(8);
const clipY = new Float64Array(8);
const clipW = new Float64Array(8);

function includeClipPoint(bounds: ProjectedBounds, clipPointX: number, clipPointY: number, clipPointW: number): void {
  if (clipPointW < MIN_CLIP_W) return;
  const inverseW = 1 / clipPointW;
  const x = clipPointX * inverseW;
  const y = clipPointY * inverseW;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.minW = Math.min(bounds.minW, clipPointW);
}

/** Conservatively projects an axis-aligned world-space box, clipping its edges at the camera plane. */
export function projectWorldBounds(minimum: Vector3, maximum: Vector3, transform: Matrix,
                                   result?: ProjectedBounds): ProjectedBounds | undefined {
  const matrix = transform.m;
  for (let index = 0; index < 8; index++) {
    const x = index & 1 ? maximum.x : minimum.x;
    const y = index & 2 ? maximum.y : minimum.y;
    const z = index & 4 ? maximum.z : minimum.z;
    clipX[index] = x * matrix[0] + y * matrix[4] + z * matrix[8] + matrix[12];
    clipY[index] = x * matrix[1] + y * matrix[5] + z * matrix[9] + matrix[13];
    clipW[index] = x * matrix[3] + y * matrix[7] + z * matrix[11] + matrix[15];
  }

  const bounds = result ?? { minX: 0, minY: 0, maxX: 0, maxY: 0, minW: 0 };
  bounds.minX = Number.POSITIVE_INFINITY;
  bounds.minY = Number.POSITIVE_INFINITY;
  bounds.maxX = Number.NEGATIVE_INFINITY;
  bounds.maxY = Number.NEGATIVE_INFINITY;
  bounds.minW = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 8; index++) includeClipPoint(bounds, clipX[index], clipY[index], clipW[index]);
  for (let axis = 0; axis < 3; axis++) {
    const mask = 1 << axis;
    for (let index = 0; index < 8; index++) {
      if (index & mask) continue;
      const secondIndex = index | mask;
      if ((clipW[index] >= MIN_CLIP_W) === (clipW[secondIndex] >= MIN_CLIP_W)) continue;
      const amount = (MIN_CLIP_W - clipW[index]) / (clipW[secondIndex] - clipW[index]);
      includeClipPoint(bounds, clipX[index] + (clipX[secondIndex] - clipX[index]) * amount,
        clipY[index] + (clipY[secondIndex] - clipY[index]) * amount, MIN_CLIP_W);
    }
  }
  return Number.isFinite(bounds.minX) ? bounds : undefined;
}

export function mergeProjectedBounds(target: ProjectedBounds | undefined, source: ProjectedBounds): ProjectedBounds {
  if (!target) return { ...source };
  target.minX = Math.min(target.minX, source.minX);
  target.minY = Math.min(target.minY, source.minY);
  target.maxX = Math.max(target.maxX, source.maxX);
  target.maxY = Math.max(target.maxY, source.maxY);
  target.minW = Math.min(target.minW, source.minW);
  return target;
}

export function expandProjectedBounds(bounds: ProjectedBounds, padding: number): ProjectedBounds {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
    minW: bounds.minW,
  };
}

export function projectedBoundsIntersect(first: ProjectedBounds, second: ProjectedBounds): boolean {
  return first.maxX >= second.minX && first.minX <= second.maxX && first.maxY >= second.minY && first.minY <= second.maxY;
}

export function projectedBoundsToScissor(bounds: ProjectedBounds, width: number, height: number): PixelScissor | undefined {
  const minX = Math.max(-1, bounds.minX);
  const minY = Math.max(-1, bounds.minY);
  const maxX = Math.min(1, bounds.maxX);
  const maxY = Math.min(1, bounds.maxY);
  if (minX >= maxX || minY >= maxY) return undefined;
  const x = Math.max(0, Math.floor((minX * 0.5 + 0.5) * width));
  const y = Math.max(0, Math.floor((minY * 0.5 + 0.5) * height));
  const right = Math.min(width, Math.ceil((maxX * 0.5 + 0.5) * width));
  const top = Math.min(height, Math.ceil((maxY * 0.5 + 0.5) * height));
  return { x, y, width: right - x, height: top - y };
}
