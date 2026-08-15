// Owns long-lived GPU resources for one Eve renderer instance.
// INVARIANT: Creation/disposal mirrors the original render.ts resource list exactly.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import {
  createBackParamsBinding,
  createEnvParamsBinding,
  createParamsBinding,
  createUniformParamsBinding,
} from "./bindings";
import { BLOOM_RADIUS, PAINT_PARAMS_BYTE_SIZE, VORONOI_NOISE_PARAMS_BYTE_SIZE } from "./constants";
import { createStudioCubemap, renderStudioCubemap } from "./cubemap";
import { EVE_DARK_ENV_LIGHTS, EVE_LIGHT_ENV_LIGHTS } from "./env-lights";
import { meshOrbitTarget, meshThicknessScale } from "./camera";
import { createGpuMesh } from "./mesh-gpu";
import { createPipelines } from "./pipelines";
import type { MeshData } from "./types";

export function createResources(
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
  const studioCubemap = createStudioCubemap(device, "eve-5-studio-hdr-cubemap");
  const isLight = options.theme === "light";
  const envLights = isLight ? EVE_LIGHT_ENV_LIGHTS : EVE_DARK_ENV_LIGHTS;
  renderStudioCubemap(device, studioCubemap, envLights);
  const orbitTarget = meshOrbitTarget(mesh);
  const thicknessScale = options.thicknessScale ?? meshThicknessScale(mesh.bounds);
  const paddingRadius = options.paddingRadius ?? BLOOM_RADIUS;
  const bloomEnabled = options.bloom ?? true;
  const pipelines = createPipelines(device, format);
  const gpuMesh = createGpuMesh(device, mesh);

  const insideParams = createBackParamsBinding(
    device,
    pipelines.backMaterialPipeline,
    studioCubemap,
    "eve-5-inside-params",
  );
  const backDepthParams = createUniformParamsBinding(
    device,
    pipelines.backDepthPipeline,
    "eve-5-back-depth-params",
  );
  const envBgParams = createEnvParamsBinding(
    device,
    pipelines.envBgPipeline,
    studioCubemap,
    "eve-5-env-bg-params",
  );
  const outsideParams = createParamsBinding(
    device,
    pipelines.frontMaterialPipeline,
    studioCubemap,
    "eve-5-outside-params",
  );
  const opaqueOutsideParams = createParamsBinding(
    device,
    pipelines.opaquePipeline,
    studioCubemap,
    "eve-5-opaque-outside-params",
  );
  const wireParams = createParamsBinding(
    device,
    pipelines.wirePipeline,
    studioCubemap,
    "eve-5-wire-params",
  );
  const blurParamsBuffer = device.createBuffer({
    label: "eve-5-bloom-blur-params",
    size: 32,
    usage: ["uniform", "copy_dst"],
  });
  const compositeParamsBuffer = device.createBuffer({
    label: "eve-5-bloom-composite-params",
    size: 16,
    usage: ["uniform", "copy_dst"],
  });
  const paintParamsBuffer = device.createBuffer({
    label: "eve-5-paint-params",
    size: PAINT_PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
  });
  const voronoiNoiseParamsBuffer = device.createBuffer({
    label: "eve-5-voronoi-noise-params",
    size: VORONOI_NOISE_PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
  });
  const voronoiNoiseBindGroup = device.gpu.createBindGroup({
    label: "eve-5-voronoi-noise-bind-group",
    layout: pipelines.voronoiNoisePipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: voronoiNoiseParamsBuffer.gpu } }],
  });
  const blurSampler = device.gpu.createSampler({
    label: "eve-5-bloom-sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const previewSampler = device.gpu.createSampler({
    label: "eve-5-render-target-preview-sampler",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const previewMode = device.createBuffer({
    label: "eve-5-render-target-preview-mode",
    size: 16,
    usage: ["uniform", "copy_dst"],
  });

  const params = {
    insideParams,
    backDepthParams,
    envBgParams,
    outsideParams,
    opaqueOutsideParams,
    wireParams,
  };
  const buffers = {
    blurParamsBuffer,
    compositeParamsBuffer,
    paintParamsBuffer,
    voronoiNoiseParamsBuffer,
    previewMode,
  };
  const samplers = { blurSampler, previewSampler };

  return {
    studioCubemap,
    isLight,
    orbitTarget,
    thicknessScale,
    paddingRadius,
    bloomEnabled,
    pipelines,
    gpuMesh,
    params,
    buffers,
    samplers,
    voronoiNoiseBindGroup,
  };
}

export type RendererResources = ReturnType<typeof createResources>;

function destroyParamsBinding(binding: {
  buffer: { destroy(): void };
  fallbackBackMaterial?: GPUTexture;
  fallbackBackDepth?: GPUTexture;
  fallbackPaint?: GPUTexture;
  fallbackVoronoiValue?: GPUTexture;
  fallbackVoronoiEdge?: GPUTexture;
}) {
  binding.buffer.destroy();
  binding.fallbackBackMaterial?.destroy();
  binding.fallbackBackDepth?.destroy();
  binding.fallbackPaint?.destroy();
  binding.fallbackVoronoiValue?.destroy();
  binding.fallbackVoronoiEdge?.destroy();
}

export function disposeResources(resources: RendererResources) {
  resources.gpuMesh.vertexBuffer.destroy();
  resources.gpuMesh.indexBuffer.destroy();
  resources.gpuMesh.lineIndexBuffer.destroy();
  destroyParamsBinding(resources.params.insideParams);
  destroyParamsBinding(resources.params.backDepthParams);
  destroyParamsBinding(resources.params.outsideParams);
  destroyParamsBinding(resources.params.opaqueOutsideParams);
  destroyParamsBinding(resources.params.wireParams);
  destroyParamsBinding(resources.params.envBgParams);
  resources.buffers.blurParamsBuffer.destroy();
  resources.buffers.compositeParamsBuffer.destroy();
  resources.buffers.paintParamsBuffer.destroy();
  resources.buffers.voronoiNoiseParamsBuffer.destroy();
  resources.buffers.previewMode.destroy();
  resources.studioCubemap.faceParams.destroy();
  resources.studioCubemap.texture.destroy();
}
