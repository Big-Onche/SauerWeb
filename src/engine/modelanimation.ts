// Original: src/engine/animmodel.h animmodel::calcanim() and animpos::setframes().
// Configured animation speed is frames per second; zero keeps Sauerbraten's default 100 ms per frame.
export function modelAnimationSpeed(configuredSpeed: number): number {
  return configuredSpeed > 0 ? configuredSpeed : 10;
}

export interface ModelAnimationPosition {
  frame: number;
  nextFrame: number;
  interpolation: number;
}

export function modelAnimationPosition(frameCount: number, configuredSpeed: number, milliseconds: number, loop: boolean, startOffset = 0,
                                       endOffset = 0): ModelAnimationPosition {
  const { start, range } = modelAnimationRange(frameCount, startOffset, endOffset);
  const progress = Math.max(0, milliseconds * modelAnimationSpeed(configuredSpeed) / 1000);
  const elapsedFrame = Math.floor(progress);
  const interpolation = progress - elapsedFrame;
  const frame = start + (loop ? elapsedFrame % range : Math.min(range - 1, elapsedFrame));
  const nextFrame = loop ? (frame + 1 < start + range ? frame + 1 : start) : Math.min(frame + 1, start + range - 1);
  return { frame, nextFrame, interpolation };
}

export function modelAnimationFrame(frameCount: number, configuredSpeed: number, milliseconds: number, loop: boolean, startOffset = 0,
                                    endOffset = 0): number {
  return modelAnimationPosition(frameCount, configuredSpeed, milliseconds, loop, startOffset, endOffset).frame;
}

function modelAnimationRange(frameCount: number, startOffset: number, endOffset: number): { start: number; range: number } {
  let start = 0;
  let range = frameCount;
  if (startOffset > 0) start += Math.min(startOffset, range - 1);
  else if (startOffset < 0) start += Math.max(range + startOffset, 0);
  range -= start;
  if (endOffset > 0) range = Math.min(range, endOffset);
  else if (endOffset < 0) range = Math.max(range + endOffset, 1);
  return { start, range };
}
