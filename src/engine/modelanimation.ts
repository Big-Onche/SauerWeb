// Original: src/engine/animmodel.h animmodel::calcanim() and animpos::setframes().
// Configured animation speed is frames per second; zero keeps Sauerbraten's default 100 ms per frame.
export function modelAnimationSpeed(configuredSpeed: number): number {
  return configuredSpeed > 0 ? configuredSpeed : 10;
}

export function modelAnimationFrame(frameCount: number, configuredSpeed: number, milliseconds: number, loop: boolean, startOffset = 0,
                                    endOffset = 0): number {
  let start = 0;
  let range = frameCount;
  if (startOffset > 0) start += Math.min(startOffset, range - 1);
  else if (startOffset < 0) start += Math.max(range + startOffset, 0);
  range -= start;
  if (endOffset > 0) range = Math.min(range, endOffset);
  else if (endOffset < 0) range = Math.max(range + endOffset, 1);
  const frame = Math.max(0, Math.floor(milliseconds * modelAnimationSpeed(configuredSpeed) / 1000));
  return start + (loop ? frame % range : Math.min(range - 1, frame));
}
