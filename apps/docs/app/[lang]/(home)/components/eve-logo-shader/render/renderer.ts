// Composes Eve renderer resources and owns the frame graph behind the facade.
// INVARIANT: This file orders passes only; subsystems own their resources and disposal.
// Imported exclusively by render.ts.

import { Device } from "@vgpu/core";
import { BLOOM_STRENGTH_OFF, BLOOM_STRENGTH_ON } from "./constants";
import { clampUnit, mix } from "./math";
import { createPaintSystem } from "./paint-system";
import { renderBackDepth, renderBackMaterial } from "./passes/back-pass";
import { renderBlur, renderComposite } from "./passes/bloom-pass";
import { renderTargetPreview, renderThicknessDebug } from "./passes/debug-passes";
import { renderLightComposite } from "./passes/light-composite-pass";
import { renderScene } from "./passes/scene-pass";
import { createResources, disposeResources } from "./resources";
import { createBloomTargetCache } from "./targets";
import type { ImprintRenderOptions, MeshData, RenderControls } from "./types";

export function createEve5Renderer(
  device: Device,
  format: GPUTextureFormat,
  mesh: MeshData,
  options: {
    thicknessScale?: number;
    theme?: "light" | "dark";
    paddingRadius?: number;
    bloom?: boolean;
  } = {},
) {
  const resources = createResources(device, format, mesh, options);
  const bloomTargets = createBloomTargetCache(device, resources.paddingRadius);
  const paintSystem = createPaintSystem(device, resources, mesh);

  const renderGlassTarget = (
    target: GPUTextureView,
    controls: RenderControls,
    logicalWidth: number,
    logicalHeight: number,
    imprint: ImprintRenderOptions = {},
  ) => {
    const safeWidth = Math.max(1, Math.round(logicalWidth));
    const safeHeight = Math.max(1, Math.round(logicalHeight));
    const targets = bloomTargets.ensure(safeWidth, safeHeight);
    const currentPaintTargets = paintSystem.ensure(safeWidth, safeHeight);
    const backSurfaceDepthView = targets.backSurfaceDepth.createView();

    renderBackMaterial(
      device,
      resources,
      mesh,
      targets.backMaterial.createView(),
      backSurfaceDepthView,
      controls,
      safeWidth,
      safeHeight,
    );
    renderBackDepth(
      device,
      resources,
      mesh,
      targets.backDepth.createView(),
      backSurfaceDepthView,
      controls,
      safeWidth,
      safeHeight,
    );

    paintSystem.apply(currentPaintTargets, imprint.paint);

    if (controls.material === "back-albedo" || controls.material === "back-depth") {
      renderTargetPreview(device, resources, mesh, target, targets, controls);
      return;
    }
    if (controls.material === "thickness") {
      renderThicknessDebug(
        device,
        resources,
        mesh,
        target,
        targets.backMaterial,
        targets.backDepth,
        currentPaintTargets.readIsPing ? currentPaintTargets.ping : currentPaintTargets.pong,
        controls,
        safeWidth,
        safeHeight,
      );
      return;
    }
    if (controls.material === "paint-debug") {
      paintSystem.renderDebug(target, currentPaintTargets);
      return;
    }

    paintSystem.renderVoronoiNoise(
      currentPaintTargets,
      controls,
      safeWidth,
      safeHeight,
      resources.paddingRadius,
      imprint,
    );
    renderScene(
      device,
      resources,
      mesh,
      targets.scene.createView(),
      targets.backMaterial,
      targets.backDepth,
      currentPaintTargets.readIsPing ? currentPaintTargets.ping : currentPaintTargets.pong,
      currentPaintTargets.voronoiValue,
      currentPaintTargets.voronoiEdge,
      controls,
      safeWidth,
      safeHeight,
      resources.paddingRadius,
      imprint,
    );

    if (resources.isLight) {
      renderLightComposite(device, resources, target, targets);
      return;
    }
    if (!resources.bloomEnabled) {
      renderComposite(device, resources, target, targets, targets.scene, 0);
      return;
    }
    const effectiveBloomStrength = mix(
      BLOOM_STRENGTH_OFF,
      BLOOM_STRENGTH_ON,
      clampUnit(imprint.progress ?? 0),
    );
    renderBlur(device, resources, targets.scene, targets.horizontal, [1, 0], true);
    renderBlur(device, resources, targets.horizontal, targets.vertical, [0, 1], false);
    renderComposite(device, resources, target, targets, targets.vertical, effectiveBloomStrength);
  };

  return {
    render(
      target: GPUTextureView,
      controls: RenderControls,
      logicalWidth: number,
      logicalHeight: number,
      imprint?: ImprintRenderOptions,
    ) {
      renderGlassTarget(target, controls, logicalWidth, logicalHeight, imprint);
    },
    dispose() {
      paintSystem.dispose();
      bloomTargets.dispose();
      disposeResources(resources);
    },
  };
}
