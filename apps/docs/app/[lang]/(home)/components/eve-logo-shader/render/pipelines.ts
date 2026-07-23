// Declarative render pipeline creation with fixed vertex layout/bindings.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device } from "@vgpu/core";
import { createRenderPipeline } from "@vgpu/render";
import { BACK_DEPTH_FORMAT, PAINT_FORMAT, SCENE_FORMAT, VORONOI_NOISE_FORMAT } from "./constants";
import { createShaders } from "./shaders";

export function createPipelines(device: Device, format: GPUTextureFormat) {
  const shaders = createShaders(device);
  const vertexLayout: GPUVertexBufferLayout = {
    arrayStride: 6 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
    ],
  };

  const backMaterialPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-back-material-pipeline",
    shader: shaders.glassBack,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: {
      entry: "fs_main",
      targets: [
        {
          format: SCENE_FORMAT,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: BACK_DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
  });

  const backDepthPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-back-depth-pipeline",
    shader: shaders.glassBackDepth,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
    depthStencil: {
      format: BACK_DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    },
  });

  const frontMaterialPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-front-material-pipeline",
    shader: shaders.glassFront,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: {
      entry: "fs_main",
      targets: [
        {
          format: SCENE_FORMAT,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const frontDisplayPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-front-display-pipeline",
    shader: shaders.glassFront,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const opaquePipeline = createRenderPipeline(device, {
    label: "eve-5-opaque-material-pipeline",
    shader: shaders.glassFront,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: {
      entry: "fs_main",
      targets: [
        {
          format: SCENE_FORMAT,
          blend: {
            color: { srcFactor: "one", dstFactor: "zero", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const wirePipeline = createRenderPipeline(device, {
    label: "eve-5-wireframe-pipeline",
    shader: shaders.glassFront,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: {
      entry: "fs_main",
      targets: [
        {
          format: SCENE_FORMAT,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        },
      ],
    },
    primitive: { topology: "line-list" },
  });

  const blurPipeline = createRenderPipeline(device, {
    label: "eve-5-bloom-blur-pipeline",
    shader: shaders.bloomBlur,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const compositePipeline = createRenderPipeline(device, {
    label: "eve-5-bloom-composite-pipeline",
    shader: shaders.bloomComposite,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const lightCompositePipeline = createRenderPipeline(device, {
    label: "eve-5-light-composite-pipeline",
    shader: shaders.lightComposite,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const envBgPipeline = createRenderPipeline(device, {
    label: "eve-5-env-bg-pipeline",
    shader: shaders.envBg,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const previewPipeline = createRenderPipeline(device, {
    label: "eve-5-render-target-preview-pipeline",
    shader: shaders.preview,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const paintDecayPipeline = createRenderPipeline(device, {
    label: "eve-5-paint-decay-pipeline",
    shader: shaders.paintUpdate,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: PAINT_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const paintDebugPipeline = createRenderPipeline(device, {
    label: "eve-5-paint-debug-pipeline",
    shader: shaders.paintDebug,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const voronoiNoisePipeline = createRenderPipeline(device, {
    label: "eve-5-voronoi-noise-update-pipeline",
    shader: shaders.voronoiNoiseUpdate,
    vertex: { entry: "vs_main" },
    fragment: {
      entry: "fs_main",
      targets: [{ format: VORONOI_NOISE_FORMAT }, { format: VORONOI_NOISE_FORMAT }],
    },
    primitive: { topology: "triangle-list" },
  });
  return {
    backMaterialPipeline,
    backDepthPipeline,
    frontMaterialPipeline,
    frontDisplayPipeline,
    opaquePipeline,
    wirePipeline,
    blurPipeline,
    compositePipeline,
    lightCompositePipeline,
    envBgPipeline,
    previewPipeline,
    paintDecayPipeline,
    paintDebugPipeline,
    voronoiNoisePipeline,
  };
}
