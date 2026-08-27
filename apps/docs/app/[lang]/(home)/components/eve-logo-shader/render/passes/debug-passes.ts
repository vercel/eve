// Encodes non-main debug display passes: target preview and thickness visualization.
// INVARIANT: Debug passes use display-format front pipeline and do not change paint parity.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import { cameraAxisDepthRange } from "../camera";
import { createParamsBindGroup } from "../bindings";
import { PASS_OUTSIDE, PREVIEW_BACK_ALBEDO, PREVIEW_BACK_DEPTH } from "../constants";
import { cameraBasis, orbitEye } from "../math";
import { writeParams } from "../params";
import type { RendererResources } from "../resources";
import type { BloomTargets, MeshData, RenderControls } from "../types";

export function renderTargetPreview(
  device: Device,
  resources: RendererResources,
  mesh: MeshData,
  view: GPUTextureView,
  targets: BloomTargets,
  controls: RenderControls,
) {
  const basis = cameraBasis(
    orbitEye(resources.orbitTarget, controls.radius, controls.yaw, controls.pitch),
    resources.orbitTarget,
  );
  const depthRange = cameraAxisDepthRange(mesh.bounds, basis.forward);
  resources.buffers.previewMode.write(
    new Float32Array([
      controls.material === "back-depth" ? PREVIEW_BACK_DEPTH : PREVIEW_BACK_ALBEDO,
      depthRange.min,
      depthRange.max,
      0,
    ]),
  );
  const bindGroup = device.gpu.createBindGroup({
    label: "eve-5-render-target-preview-bind-group",
    layout: resources.pipelines.previewPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: targets.backMaterial.createView() },
      { binding: 1, resource: targets.backDepth.createView() },
      { binding: 2, resource: resources.samplers.previewSampler },
      { binding: 3, resource: { buffer: resources.buffers.previewMode.gpu } },
    ],
  });
  const pass = new RenderPass(device, {
    label: "eve-5-render-target-preview-pass",
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  pass.setPipeline(resources.pipelines.previewPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

export function renderThicknessDebug(
  device: Device,
  resources: RendererResources,
  mesh: MeshData,
  view: GPUTextureView,
  backMaterial: GPUTexture,
  backDepth: GPUTexture,
  paintTexture: GPUTexture,
  controls: RenderControls,
  logicalWidth: number,
  logicalHeight: number,
  projectionPaddingRadius = resources.paddingRadius,
) {
  writeParams({
    target: resources.params.outsideParams,
    controls,
    logicalWidth,
    logicalHeight,
    passKind: PASS_OUTSIDE,
    projectionPaddingRadius,
    meshBounds: mesh.bounds,
    orbitTarget: resources.orbitTarget,
    thicknessScale: resources.thicknessScale,
    isLight: resources.isLight,
  });
  const outsideBindGroup = createParamsBindGroup(
    device,
    resources.pipelines.frontDisplayPipeline,
    resources.studioCubemap,
    resources.params.outsideParams.buffer,
    backMaterial.createView(),
    backDepth.createView(),
    paintTexture.createView(),
    resources.params.outsideParams.fallbackVoronoiValue.createView(),
    resources.params.outsideParams.fallbackVoronoiEdge.createView(),
    "eve-5-thickness-debug-params-bind-group",
  );

  const pass = new RenderPass(device, {
    label: "eve-5-thickness-debug-pass",
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  pass.setVertexBuffer(0, resources.gpuMesh.vertexBuffer);
  pass.gpu.setIndexBuffer(resources.gpuMesh.indexBuffer.gpu, "uint32");
  if (controls.outsideRendering) {
    pass.setPipeline(resources.pipelines.frontDisplayPipeline);
    pass.setBindGroup(0, outsideBindGroup);
    pass.gpu.drawIndexed(resources.gpuMesh.indexCount, 1, 0, 0, 0);
  }
  pass.end();
}
