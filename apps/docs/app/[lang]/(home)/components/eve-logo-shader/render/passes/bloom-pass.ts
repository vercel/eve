// Encodes bloom blur and dark-theme composite passes.
// INVARIANT: Bloom extract/blur/composite order and blend strength math remain in renderer.ts.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import { BLOOM_STRENGTH_OFF, BLOOM_THRESHOLD } from "../constants";
import type { RendererResources } from "../resources";
import type { BloomTargets } from "../types";

export function renderBlur(
  device: Device,
  resources: RendererResources,
  source: GPUTexture,
  target: GPUTexture,
  direction: [number, number],
  extract: boolean,
  radius: number,
) {
  const kernelRadius = Math.max(0, Math.round(radius));
  const sigma = Math.max(0.001, kernelRadius / 3);
  resources.buffers.blurParamsBuffer.write(
    new Float32Array([
      direction[0],
      direction[1],
      extract ? 1 : 0,
      BLOOM_THRESHOLD,
      kernelRadius,
      sigma,
      0,
      0,
    ]),
  );
  const bindGroup = device.gpu.createBindGroup({
    label: "eve-5-bloom-blur-bind-group",
    layout: resources.pipelines.blurPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: resources.samplers.blurSampler },
      { binding: 2, resource: { buffer: resources.buffers.blurParamsBuffer.gpu } },
    ],
  });
  const pass = new RenderPass(device, {
    label: `eve-5-bloom-${direction[0] > 0 ? "horizontal" : "vertical"}-pass`,
    colorAttachments: [
      { view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
    ],
  });
  pass.setPipeline(resources.pipelines.blurPipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}

export function renderComposite(
  device: Device,
  resources: RendererResources,
  view: GPUTextureView,
  targets: BloomTargets,
  bloomTexture: GPUTexture = targets.vertical,
  strength = BLOOM_STRENGTH_OFF,
) {
  resources.buffers.compositeParamsBuffer.write(new Float32Array([strength, 0, 0, 0]));
  const bindGroup = device.gpu.createBindGroup({
    label: "eve-5-bloom-composite-bind-group",
    layout: resources.pipelines.compositePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: targets.scene.createView() },
      { binding: 1, resource: bloomTexture.createView() },
      { binding: 2, resource: resources.samplers.blurSampler },
      { binding: 3, resource: { buffer: resources.buffers.compositeParamsBuffer.gpu } },
    ],
  });
  const pass = new RenderPass(device, {
    label: "eve-5-composite-tonemap-pass",
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });
  pass.setPipeline(resources.pipelines.compositePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}
