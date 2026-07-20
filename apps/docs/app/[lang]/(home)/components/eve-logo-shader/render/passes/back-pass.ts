// Encodes the back material and back camera-axis depth passes.
// INVARIANT: Back material renders before front scene; pass kind and depth state are shader ABI inputs.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import { PASS_INSIDE } from "../constants";
import { writeParams } from "../params";
import type { RendererResources } from "../resources";
import type { MeshData, RenderControls } from "../types";

export function renderBackMaterial(
  device: Device,
  resources: RendererResources,
  mesh: MeshData,
  target: GPUTextureView,
  depth: GPUTextureView,
  controls: RenderControls,
  logicalWidth: number,
  logicalHeight: number,
  projectionPaddingRadius = resources.paddingRadius,
) {
  writeParams({
    target: resources.params.insideParams,
    controls,
    logicalWidth,
    logicalHeight,
    passKind: PASS_INSIDE,
    projectionPaddingRadius,
    meshBounds: mesh.bounds,
    orbitTarget: resources.orbitTarget,
    thicknessScale: resources.thicknessScale,
    isLight: resources.isLight,
  });
  const pass = new RenderPass(device, {
    label: "eve-5-back-material-pass",
    colorAttachments: [
      { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
    ],
    depthStencilAttachment: {
      view: depth,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
  });
  if (controls.insideRendering) {
    pass.setPipeline(resources.pipelines.backMaterialPipeline);
    pass.setVertexBuffer(0, resources.gpuMesh.vertexBuffer);
    pass.gpu.setIndexBuffer(resources.gpuMesh.indexBuffer.gpu, "uint32");
    pass.setBindGroup(0, resources.params.insideParams.bindGroup);
    pass.gpu.drawIndexed(resources.gpuMesh.indexCount, 1, 0, 0, 0);
  }
  pass.end();
}

export function renderBackDepth(
  device: Device,
  resources: RendererResources,
  mesh: MeshData,
  target: GPUTextureView,
  depth: GPUTextureView,
  controls: RenderControls,
  logicalWidth: number,
  logicalHeight: number,
  projectionPaddingRadius = resources.paddingRadius,
) {
  writeParams({
    target: resources.params.backDepthParams,
    controls,
    logicalWidth,
    logicalHeight,
    passKind: PASS_INSIDE,
    projectionPaddingRadius,
    meshBounds: mesh.bounds,
    orbitTarget: resources.orbitTarget,
    thicknessScale: resources.thicknessScale,
    isLight: resources.isLight,
  });
  const pass = new RenderPass(device, {
    label: "eve-5-back-depth-pass",
    colorAttachments: [
      { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
    ],
    depthStencilAttachment: {
      view: depth,
      depthLoadOp: "load",
      depthStoreOp: "store",
    },
  });
  if (controls.insideRendering) {
    pass.setPipeline(resources.pipelines.backDepthPipeline);
    pass.setVertexBuffer(0, resources.gpuMesh.vertexBuffer);
    pass.gpu.setIndexBuffer(resources.gpuMesh.indexBuffer.gpu, "uint32");
    pass.setBindGroup(0, resources.params.backDepthParams.bindGroup);
    pass.gpu.drawIndexed(resources.gpuMesh.indexCount, 1, 0, 0, 0);
  }
  pass.end();
}
