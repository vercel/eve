// Encodes the light-theme premultiplied composite pass.
// INVARIANT: Clear alpha remains 0 for light theme compositing.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import type { RendererResources } from "../resources";
import type { BloomTargets } from "../types";

export function renderLightComposite(
  device: Device,
  resources: RendererResources,
  view: GPUTextureView,
  targets: BloomTargets,
) {
  const bindGroup = device.gpu.createBindGroup({
    label: "eve-5-light-composite-bind-group",
    layout: resources.pipelines.lightCompositePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: targets.scene.createView() },
      { binding: 1, resource: resources.samplers.blurSampler },
    ],
  });
  const pass = new RenderPass(device, {
    label: "eve-5-light-composite-premultiplied-pass",
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
  });
  pass.setPipeline(resources.pipelines.lightCompositePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
}
