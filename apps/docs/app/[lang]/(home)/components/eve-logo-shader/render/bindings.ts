// Bind-group creators; front bindings 0-7 remain ABI-stable.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device, type Buffer } from "@vgpu/core";
import { PAINT_FORMAT, PARAMS_BYTE_SIZE, SCENE_FORMAT, VORONOI_NOISE_FORMAT } from "./constants";
import type { StudioCubemap } from "./types";

export function createEnvParamsBinding(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  label: string,
) {
  const buffer = device.createBuffer({
    size: PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
    label,
  });
  const bindGroup = device.gpu.createBindGroup({
    label: `${label}-bind-group`,
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffer.gpu } },
      { binding: 1, resource: cubemap.view },
      { binding: 2, resource: cubemap.sampler },
    ],
  });
  return { buffer, bindGroup };
}

export function createBackParamsBinding(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  label: string,
) {
  const buffer = device.createBuffer({
    size: PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
    label,
  });
  const bindGroup = device.gpu.createBindGroup({
    label: `${label}-bind-group`,
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffer.gpu } },
      { binding: 1, resource: cubemap.view },
      { binding: 2, resource: cubemap.sampler },
    ],
  });
  return { buffer, bindGroup };
}

export function createUniformParamsBinding(
  device: Device,
  pipeline: GPURenderPipeline,
  label: string,
) {
  const buffer = device.createBuffer({
    size: PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
    label,
  });
  const bindGroup = device.gpu.createBindGroup({
    label: `${label}-bind-group`,
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: buffer.gpu } }],
  });
  return { buffer, bindGroup };
}

export function createPaintDecayBindGroup(
  device: Device,
  pipeline: GPURenderPipeline,
  paintView: GPUTextureView,
  staticNoiseView: GPUTextureView,
  paintParamsBuffer: Buffer,
  label: string,
) {
  return device.gpu.createBindGroup({
    label,
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: paintView },
      { binding: 1, resource: { buffer: paintParamsBuffer.gpu } },
      { binding: 2, resource: staticNoiseView },
    ],
  });
}

export function createPaintDebugBindGroup(
  device: Device,
  pipeline: GPURenderPipeline,
  paintView: GPUTextureView,
  label: string,
) {
  return device.gpu.createBindGroup({
    label,
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: paintView }],
  });
}

export function createParamsBinding(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  label: string,
  backMaterialView?: GPUTextureView,
  backDepthView?: GPUTextureView,
) {
  const buffer = device.createBuffer({
    size: PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
    label,
  });
  const fallbackBackMaterial = device.gpu.createTexture({
    label: `${label}-empty-back-material`,
    size: [1, 1],
    format: SCENE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fallbackBackDepth = device.gpu.createTexture({
    label: `${label}-empty-back-depth`,
    size: [1, 1],
    format: SCENE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fallbackPaint = device.gpu.createTexture({
    label: `${label}-empty-paint`,
    size: [1, 1],
    format: PAINT_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fallbackVoronoiValue = device.gpu.createTexture({
    label: `${label}-empty-voronoi-value`,
    size: [1, 1],
    format: VORONOI_NOISE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const fallbackVoronoiEdge = device.gpu.createTexture({
    label: `${label}-empty-voronoi-edge`,
    size: [1, 1],
    format: VORONOI_NOISE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const bindGroup = createParamsBindGroup(
    device,
    pipeline,
    cubemap,
    buffer,
    backMaterialView ?? fallbackBackMaterial.createView(),
    backDepthView ?? fallbackBackDepth.createView(),
    fallbackPaint.createView(),
    fallbackVoronoiValue.createView(),
    fallbackVoronoiEdge.createView(),
    `${label}-bind-group`,
  );
  return {
    buffer,
    bindGroup,
    fallbackBackMaterial,
    fallbackBackDepth,
    fallbackPaint,
    fallbackVoronoiValue,
    fallbackVoronoiEdge,
  };
}

export function createParamsBindGroup(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  buffer: Buffer,
  backMaterialView: GPUTextureView,
  backDepthView: GPUTextureView,
  paintView: GPUTextureView,
  voronoiValueView: GPUTextureView,
  voronoiEdgeView: GPUTextureView,
  label: string,
) {
  return device.gpu.createBindGroup({
    label,
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: buffer.gpu } },
      { binding: 1, resource: cubemap.view },
      { binding: 2, resource: cubemap.sampler },
      { binding: 3, resource: backMaterialView },
      { binding: 4, resource: backDepthView },
      { binding: 5, resource: paintView },
      { binding: 6, resource: voronoiValueView },
      { binding: 7, resource: voronoiEdgeView },
    ],
  });
}
