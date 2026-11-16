import type { Animatable } from "@babylonjs/core/Animations/animatable";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { AnimationGroupMask, AnimationGroupMaskMode } from "@babylonjs/core/Animations/animationGroupMask";
import { describe, expect, it, vi } from "vitest";
import { goToMaskedAnimationFrame } from "./PlayerRenderer";

describe("GLB player animation masking", () => {
  it("does not let an upper-body animation overwrite locomotion targets", () => {
    const leg = animatable("Thigh.L");
    const torso = animatable("Spine1");
    const group = {
      animatables: [leg.value, torso.value],
      mask: new AnimationGroupMask(["Spine1"], AnimationGroupMaskMode.Include),
    } as AnimationGroup;

    goToMaskedAnimationFrame(group, 7.5);

    expect(leg.goToFrame).not.toHaveBeenCalled();
    expect(torso.goToFrame).toHaveBeenCalledWith(7.5);
  });

  it("evaluates lower-body targets when the upper-body names are excluded", () => {
    const leg = animatable("Thigh.L");
    const torso = animatable("Spine1");
    const group = {
      animatables: [leg.value, torso.value],
      mask: new AnimationGroupMask(["Spine1"], AnimationGroupMaskMode.Exclude),
    } as AnimationGroup;

    goToMaskedAnimationFrame(group, 12);

    expect(leg.goToFrame).toHaveBeenCalledWith(12);
    expect(torso.goToFrame).not.toHaveBeenCalled();
  });
});

function animatable(name: string): { value: Animatable; goToFrame: ReturnType<typeof vi.fn> } {
  const goToFrame = vi.fn();
  return { value: { target: { name }, goToFrame } as unknown as Animatable, goToFrame };
}
