// Studio cubemap allocation and one-time bake pass.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";
import eveCubemapWgsl from "../shaders/cubemap/render.wgsl";
import {
  CUBE_FACE_COUNT,
  CUBE_FORMAT,
  CUBE_LIGHT_FLOAT_COUNT,
  CUBE_MAX_LIGHTS,
  CUBE_PARAMS_BYTE_SIZE,
  CUBE_PARAMS_FLOAT_COUNT,
  CUBE_SIZE,
} from "./constants";
import type { EnvLightConfig, StudioCubemap, Vec3 } from "./types";

export function createStudioCubemap(
  device: Device,
  label = "eve-5-studio-hdr-cubemap",
): StudioCubemap {
  const texture = device.gpu.createTexture({
    label,
    size: { width: CUBE_SIZE, height: CUBE_SIZE, depthOrArrayLayers: CUBE_FACE_COUNT },
    dimension: "2d",
    format: CUBE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  // Dawn's node adapter runs in compatibility mode and validates cube views as 2D arrays.
  // Keep the asset semantically as a cubemap, but bind/sample it as six array layers.
  const view = texture.createView({
    dimension: "2d-array",
    baseArrayLayer: 0,
    arrayLayerCount: CUBE_FACE_COUNT,
  });
  const sampler = device.gpu.createSampler({
    label: "eve-5-studio-hdr-cubemap-sampler",
    magFilter: "linear",
    minFilter: "linear",
  });
  const faceParams = device.createBuffer({
    label: "eve-5-studio-cubemap-face-params",
    size: CUBE_PARAMS_BYTE_SIZE,
    usage: ["uniform", "copy_dst"],
  });
  return { texture, view, sampler, faceParams };
}

export function renderStudioCubemap(
  device: Device,
  cubemap: StudioCubemap,
  lights: readonly EnvLightConfig[],
  globalIntensity = 1,
) {
  const pipeline = createRenderPipeline(device, {
    label: "eve-5-studio-cubemap-bake-pipeline",
    shader: device.createShader(compile(eveCubemapWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: CUBE_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const bindGroup = device.gpu.createBindGroup({
    label: "eve-5-studio-cubemap-bake-bind-group",
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: cubemap.faceParams.gpu } }],
  });

  for (let face = 0; face < CUBE_FACE_COUNT; face += 1) {
    cubemap.faceParams.write(cubeParamsData(face, lights, globalIntensity));
    const pass = new RenderPass(device, {
      label: `eve-5-studio-cubemap-face-${face}`,
      colorAttachments: [
        {
          view: cubemap.texture.createView({
            dimension: "2d",
            baseArrayLayer: face,
            arrayLayerCount: 1,
          }),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
}

export function cubeParamsData(
  face: number,
  lights: readonly EnvLightConfig[],
  globalIntensity: number,
) {
  if (lights.length > CUBE_MAX_LIGHTS) {
    throw new Error(
      `Studio cubemap supports up to ${CUBE_MAX_LIGHTS} lights, received ${lights.length}`,
    );
  }

  const data = new Float32Array(CUBE_PARAMS_FLOAT_COUNT);
  data[0] = face;
  data[1] = lights.length;

  lights.forEach((light, index) => {
    const [r, g, b] = lightColorLinear(light);
    const offset = 4 + index * CUBE_LIGHT_FLOAT_COUNT;
    data[offset] = light.position[0];
    data[offset + 1] = light.position[1];
    data[offset + 2] = light.position[2];
    data[offset + 3] = light.radius;
    data[offset + 4] = r;
    data[offset + 5] = g;
    data[offset + 6] = b;
    data[offset + 7] = light.intensity * globalIntensity;
    data[offset + 8] = light.softness;
    data[offset + 9] = light.luminance;
  });

  return data;
}

export function lightColorLinear(light: EnvLightConfig): Vec3 {
  return srgbHexToLinear(light.color);
}

export function srgbHexToLinear(hex: string): Vec3 {
  const normalized = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Expected a 6-digit sRGB hex color, received ${hex}`);
  }
  return [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as Vec3;
}
