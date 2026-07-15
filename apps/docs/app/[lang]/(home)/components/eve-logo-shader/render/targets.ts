// Owns resize-sensitive bloom/back render targets.
// INVARIANT: Target formats, labels, and destroy-before-recreate order match the original renderer.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { createBackDepthTexture, createBloomTexture, getPaddedRenderSize } from "./textures";
import type { BloomTargets } from "./types";

export function createBloomTargetCache(device: Device) {
  let targets: (BloomTargets & { paddingRadius: number }) | undefined;

  const dispose = () => {
    targets?.scene.destroy();
    targets?.backMaterial.destroy();
    targets?.backDepth.destroy();
    targets?.backSurfaceDepth.destroy();
    targets?.horizontal.destroy();
    targets?.vertical.destroy();
    targets = undefined;
  };

  return {
    ensure(logicalWidth: number, logicalHeight: number, paddingRadius: number) {
      const padded = getPaddedRenderSize(logicalWidth, logicalHeight, paddingRadius);
      if (
        targets?.width === padded.width &&
        targets.height === padded.height &&
        targets.paddingRadius === paddingRadius
      ) {
        return targets;
      }
      dispose();
      targets = {
        width: padded.width,
        height: padded.height,
        paddingRadius,
        scene: createBloomTexture(device, "eve-5-scene-linear-hdr", padded.width, padded.height),
        backMaterial: createBloomTexture(
          device,
          "eve-5-back-material-linear-hdr",
          padded.width,
          padded.height,
        ),
        backDepth: createBloomTexture(
          device,
          "eve-5-back-camera-axis-depth",
          padded.width,
          padded.height,
        ),
        backSurfaceDepth: createBackDepthTexture(
          device,
          "eve-5-back-surface-depth",
          padded.width,
          padded.height,
        ),
        horizontal: createBloomTexture(
          device,
          "eve-5-bloom-horizontal",
          padded.width,
          padded.height,
        ),
        vertical: createBloomTexture(device, "eve-5-bloom-vertical", padded.width, padded.height),
      };
      return targets;
    },
    dispose,
  };
}
