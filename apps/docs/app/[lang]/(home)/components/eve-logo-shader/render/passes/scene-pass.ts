// Encodes the main front scene pass and wireframe/environment overlays.
// INVARIANT: Front binding indices 0-7 and back-before-front ordering are unchanged.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import { createParamsBindGroup } from "../bindings";
import { PASS_OUTSIDE, PASS_WIREFRAME } from "../constants";
import { writeParams } from "../params";
import type { RendererResources } from "../resources";
import type { ImprintRenderOptions, MeshData, RenderControls } from "../types";

export function renderScene(
  device: Device,
  resources: RendererResources,
  mesh: MeshData,
  view: GPUTextureView,
  backMaterial: GPUTexture,
  backDepth: GPUTexture,
  paintTexture: GPUTexture,
  voronoiValueTexture: GPUTexture,
  voronoiEdgeTexture: GPUTexture,
  controls: RenderControls,
  logicalWidth: number,
  logicalHeight: number,
  projectionPaddingRadius = resources.paddingRadius,
  imprint: ImprintRenderOptions = {},
) {
  const paramsBase = {
    controls,
    logicalWidth,
    logicalHeight,
    projectionPaddingRadius,
    meshBounds: mesh.bounds,
    orbitTarget: resources.orbitTarget,
    thicknessScale: resources.thicknessScale,
    isLight: resources.isLight,
  };
  writeParams({
    ...paramsBase,
    target: resources.params.outsideParams,
    passKind: PASS_OUTSIDE,
    imprint,
  });
  writeParams({ ...paramsBase, target: resources.params.wireParams, passKind: PASS_WIREFRAME });
  writeParams({ ...paramsBase, target: resources.params.envBgParams, passKind: PASS_OUTSIDE });
  writeParams({
    ...paramsBase,
    target: resources.params.opaqueOutsideParams,
    passKind: PASS_OUTSIDE,
  });

  const outsideBindGroup = createParamsBindGroup(
    device,
    resources.pipelines.frontMaterialPipeline,
    resources.studioCubemap,
    resources.params.outsideParams.buffer,
    backMaterial.createView(),
    backDepth.createView(),
    paintTexture.createView(),
    voronoiValueTexture.createView(),
    voronoiEdgeTexture.createView(),
    "eve-5-outside-params-bind-group",
  );

  const pass = new RenderPass(device, {
    label: "eve-5-scene-hdr-pass",
    colorAttachments: [
      { view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, resources.isLight ? 0 : 1] },
    ],
  });

  // Optional environment background: draw the studio cubemap behind the logo so the lighting
  // is visible. Fullscreen triangle, no vertex buffer, so do it before binding the mesh.
  if (controls.showEnv) {
    pass.setPipeline(resources.pipelines.envBgPipeline);
    pass.setBindGroup(0, resources.params.envBgParams.bindGroup);
    pass.draw(3);
  }

  pass.setVertexBuffer(0, resources.gpuMesh.vertexBuffer);

  const needsBackTargets = controls.material === "glass" || controls.material === "thickness";
  pass.gpu.setIndexBuffer(resources.gpuMesh.indexBuffer.gpu, "uint32");
  if (needsBackTargets) {
    // The back/inside material and camera-axis depth have already been rendered into offscreen
    // targets. The main scene draws only the front/outside material; glass and thickness debug
    // both need the real back targets rather than the opaque/debug fallback bind group.
    if (controls.outsideRendering) {
      pass.setPipeline(resources.pipelines.frontMaterialPipeline);
      pass.setBindGroup(0, outsideBindGroup);
      pass.gpu.drawIndexed(resources.gpuMesh.indexCount, 1, 0, 0, 0);
    }
  } else if (controls.outsideRendering) {
    // Opaque/debug materials are single-surface views. Drawing the inside pass too would
    // double-expose through the depthless transparent ordering used by glass.
    pass.setPipeline(resources.pipelines.opaquePipeline);
    pass.setBindGroup(0, resources.params.opaqueOutsideParams.bindGroup);
    pass.gpu.drawIndexed(resources.gpuMesh.indexCount, 1, 0, 0, 0);
  }

  if (controls.wireframe) {
    pass.setPipeline(resources.pipelines.wirePipeline);
    pass.gpu.setIndexBuffer(resources.gpuMesh.lineIndexBuffer.gpu, "uint32");
    pass.setBindGroup(0, resources.params.wireParams.bindGroup);
    pass.gpu.drawIndexed(resources.gpuMesh.lineIndexCount, 1, 0, 0, 0);
  }

  pass.end();
}
