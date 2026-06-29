import { Device, type Buffer } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";
import glassBackWgsl from "./shaders/glass/back.wgsl";
import glassFrontWgsl from "./shaders/glass/front.wgsl";
import glassBackDepthWgsl from "./shaders/glass/back-depth.wgsl";
import eveBloomBlurWgsl from "./shaders/bloom/blur.wgsl";
import eveBloomCompositeWgsl from "./shaders/bloom/composite.wgsl";
import eveLightCompositeWgsl from "./shaders/postprocess/light-composite.wgsl";
import eveCubemapWgsl from "./shaders/cubemap/render.wgsl";
import eveEnvBgWgsl from "./shaders/env/background.wgsl";
import renderTargetPreviewWgsl from "./shaders/debug/render-target-preview.wgsl";

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type MeshData = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bounds: Bounds;
};

export type EveMaterial = "glass" | "normal" | "camera reflected normal" | "metallic" | "back-albedo" | "back-depth" | "thickness";

export type RenderControls = {
  yaw: number;
  pitch: number;
  radius: number;
  fov: number;
  envYaw: number;
  insideRendering: boolean;
  outsideRendering: boolean;
  material: EveMaterial;
  wireframe: boolean;
  showEnv: boolean;
};

type GpuMesh = {
  vertexBuffer: Buffer;
  indexBuffer: Buffer;
  lineIndexBuffer: Buffer;
  indexCount: number;
  lineIndexCount: number;
};

export type StudioCubemap = {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  faceParams: Buffer;
};

const PARAMS_BYTE_SIZE = 144;
const CUBE_PARAMS_BYTE_SIZE = 16;
export const CUBE_SIZE = 256;
export const CUBE_FACE_COUNT = 6;
export const CUBE_FORMAT: GPUTextureFormat = "rgba16float";
export const BLOOM_RADIUS = 16;
export const SCENE_FORMAT: GPUTextureFormat = "rgba16float";
export const BLOOM_STRENGTH = 0.85;
export const BLOOM_THRESHOLD = 0;
const BACK_DEPTH_FORMAT: GPUTextureFormat = "depth32float";

// The shader renders the back side first, then the front side. Keeping two passes
// preserves the acrylic depth/overlap cues while avoiding a depth buffer.
const PASS_INSIDE = 0;
const PASS_OUTSIDE = 1;
const PASS_WIREFRAME = 2;
const MATERIAL_KIND: Record<EveMaterial, number> = {
  glass: 0,
  normal: 1,
  "camera reflected normal": 2,
  metallic: 3,
  "back-albedo": 0,
  "back-depth": 0,
  thickness: 4,
};
const CAMERA_NEAR = 0.05;
const CAMERA_FAR = 20;
const EVE_THICKNESS_SCALE_MULTIPLIER = 1.3;
const PREVIEW_BACK_ALBEDO = 0;
const PREVIEW_BACK_DEPTH = 1;

type Mat4 = Float32Array;
type Vec3 = [number, number, number];

export function createEve5Renderer(
  device: Device,
  format: GPUTextureFormat,
  mesh: MeshData,
  options: { thicknessScale?: number; theme?: "light" | "dark" } = {},
) {
  const studioCubemap = createStudioCubemap(device);
  renderStudioCubemap(device, studioCubemap);
  const orbitTarget = meshOrbitTarget(mesh);
  const thicknessScale = options.thicknessScale ?? meshThicknessScale(mesh.bounds);
  const isLight = options.theme === "light";

  const glassBackShader = device.createShader(compile(glassBackWgsl));
  const glassFrontShader = device.createShader(compile(glassFrontWgsl));
  const glassBackDepthShader = device.createShader(compile(glassBackDepthWgsl));
  const vertexLayout: GPUVertexBufferLayout = {
    arrayStride: 6 * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x3" },
      { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
    ],
  };

  const backMaterialPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-back-material-pipeline",
    shader: glassBackShader,
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
    shader: glassBackDepthShader,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
    depthStencil: { format: BACK_DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: "less-equal" },
  });

  const frontMaterialPipeline = createRenderPipeline(device, {
    label: "eve-5-glass-front-material-pipeline",
    shader: glassFrontShader,
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
    shader: glassFrontShader,
    vertex: { entry: "vs_main", buffers: [vertexLayout] },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const opaquePipeline = createRenderPipeline(device, {
    label: "eve-5-opaque-material-pipeline",
    shader: glassFrontShader,
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
    shader: glassFrontShader,
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
    shader: device.createShader(compile(eveBloomBlurWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const compositePipeline = createRenderPipeline(device, {
    label: "eve-5-bloom-composite-pipeline",
    shader: device.createShader(compile(eveBloomCompositeWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const lightCompositePipeline = createRenderPipeline(device, {
    label: "eve-5-light-composite-pipeline",
    shader: device.createShader(compile(eveLightCompositeWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const envBgPipeline = createRenderPipeline(device, {
    label: "eve-5-env-bg-pipeline",
    shader: device.createShader(compile(eveEnvBgWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: SCENE_FORMAT }] },
    primitive: { topology: "triangle-list" },
  });

  const previewPipeline = createRenderPipeline(device, {
    label: "eve-5-render-target-preview-pipeline",
    shader: device.createShader(compile(renderTargetPreviewWgsl)),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const gpuMesh = createGpuMesh(device, mesh);
  const insideParams = createBackParamsBinding(device, backMaterialPipeline, studioCubemap, "eve-5-inside-params");
  const backDepthParams = createUniformParamsBinding(device, backDepthPipeline, "eve-5-back-depth-params");
  const envBgParams = createEnvParamsBinding(device, envBgPipeline, studioCubemap, "eve-5-env-bg-params");
  const outsideParams = createParamsBinding(device, frontMaterialPipeline, studioCubemap, "eve-5-outside-params");
  const opaqueOutsideParams = createParamsBinding(device, opaquePipeline, studioCubemap, "eve-5-opaque-outside-params");
  const wireParams = createParamsBinding(device, wirePipeline, studioCubemap, "eve-5-wire-params");
  const blurParamsBuffer = device.createBuffer({
    label: "eve-5-bloom-blur-params",
    size: 16,
    usage: ["uniform", "copy_dst"],
  });
  const compositeParamsBuffer = device.createBuffer({
    label: "eve-5-bloom-composite-params",
    size: 16,
    usage: ["uniform", "copy_dst"],
  });
  compositeParamsBuffer.write(new Float32Array([BLOOM_STRENGTH, 0, 0, 0]));
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
  let bloomTargets: BloomTargets | undefined;

  const writeParams = (target: { buffer: Buffer }, controls: RenderControls, logicalWidth: number, logicalHeight: number, passKind: number) => {
    const padded = getPaddedRenderSize(logicalWidth, logicalHeight);
    const fovRad = degreesToRadians(controls.fov);
    const verticalScale = padded.height / logicalHeight;
    const fovEff = 2 * Math.atan(verticalScale * Math.tan(fovRad * 0.5));
    const aspect = padded.width / padded.height;
    const eye = orbitEye(orbitTarget, controls.radius, controls.yaw, controls.pitch);
    const proj = perspective(fovEff, aspect, CAMERA_NEAR, CAMERA_FAR);
    const view = lookAt(eye, orbitTarget, [0, 1, 0]);
    const viewProj = multiply(proj, view);
    const basis = cameraBasis(eye, orbitTarget);
    const data = new Float32Array(36);
    data.set(viewProj, 0);
    data[16] = eye[0];
    data[17] = eye[1];
    data[18] = eye[2];
    data[19] = passKind;
    data[20] = basis.right[0];
    data[21] = basis.right[1];
    data[22] = basis.right[2];
    data[23] = fovEff;
    data[24] = basis.up[0];
    data[25] = basis.up[1];
    data[26] = basis.up[2];
    data[27] = aspect;
    data[28] = basis.forward[0];
    data[29] = basis.forward[1];
    data[30] = basis.forward[2];
    data[31] = MATERIAL_KIND[controls.material];
    data[32] = thicknessScale;
    data[33] = controls.envYaw;
    target.buffer.write(data);
  };

  const ensureBloomTargets = (logicalWidth: number, logicalHeight: number) => {
    const padded = getPaddedRenderSize(logicalWidth, logicalHeight);
    if (bloomTargets?.width === padded.width && bloomTargets.height === padded.height) return bloomTargets;
    bloomTargets?.scene.destroy();
    bloomTargets?.backMaterial.destroy();
    bloomTargets?.backDepth.destroy();
    bloomTargets?.backSurfaceDepth.destroy();
    bloomTargets?.horizontal.destroy();
    bloomTargets?.vertical.destroy();
    bloomTargets = {
      width: padded.width,
      height: padded.height,
      scene: createBloomTexture(device, "eve-5-scene-linear-hdr", padded.width, padded.height),
      backMaterial: createBloomTexture(device, "eve-5-back-material-linear-hdr", padded.width, padded.height),
      backDepth: createBloomTexture(device, "eve-5-back-camera-axis-depth", padded.width, padded.height),
      backSurfaceDepth: createBackDepthTexture(device, "eve-5-back-surface-depth", padded.width, padded.height),
      horizontal: createBloomTexture(device, "eve-5-bloom-horizontal", padded.width, padded.height),
      vertical: createBloomTexture(device, "eve-5-bloom-vertical", padded.width, padded.height),
    };
    return bloomTargets;
  };

  const renderBackMaterial = (target: GPUTextureView, depth: GPUTextureView, controls: RenderControls, logicalWidth: number, logicalHeight: number) => {
    writeParams(insideParams, controls, logicalWidth, logicalHeight, PASS_INSIDE);
    const pass = new RenderPass(device, {
      label: "eve-5-back-material-pass",
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: {
        view: depth,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    if (controls.insideRendering) {
      pass.setPipeline(backMaterialPipeline);
      pass.setVertexBuffer(0, gpuMesh.vertexBuffer);
      pass.gpu.setIndexBuffer(gpuMesh.indexBuffer.gpu, "uint32");
      pass.setBindGroup(0, insideParams.bindGroup);
      pass.gpu.drawIndexed(gpuMesh.indexCount, 1, 0, 0, 0);
    }
    pass.end();
  };

  const renderBackDepth = (target: GPUTextureView, depth: GPUTextureView, controls: RenderControls, logicalWidth: number, logicalHeight: number) => {
    writeParams(backDepthParams, controls, logicalWidth, logicalHeight, PASS_INSIDE);
    const pass = new RenderPass(device, {
      label: "eve-5-back-depth-pass",
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      depthStencilAttachment: {
        view: depth,
        depthLoadOp: "load",
        depthStoreOp: "store",
      },
    });
    if (controls.insideRendering) {
      pass.setPipeline(backDepthPipeline);
      pass.setVertexBuffer(0, gpuMesh.vertexBuffer);
      pass.gpu.setIndexBuffer(gpuMesh.indexBuffer.gpu, "uint32");
      pass.setBindGroup(0, backDepthParams.bindGroup);
      pass.gpu.drawIndexed(gpuMesh.indexCount, 1, 0, 0, 0);
    }
    pass.end();
  };

  const renderScene = (view: GPUTextureView, backMaterial: GPUTexture, backDepth: GPUTexture, controls: RenderControls, logicalWidth: number, logicalHeight: number) => {
    writeParams(outsideParams, controls, logicalWidth, logicalHeight, PASS_OUTSIDE);
    writeParams(wireParams, controls, logicalWidth, logicalHeight, PASS_WIREFRAME);
    writeParams(envBgParams, controls, logicalWidth, logicalHeight, PASS_OUTSIDE);
    writeParams(opaqueOutsideParams, controls, logicalWidth, logicalHeight, PASS_OUTSIDE);

    const outsideBindGroup = createParamsBindGroup(
      device,
      frontMaterialPipeline,
      studioCubemap,
      outsideParams.buffer,
      backMaterial.createView(),
      backDepth.createView(),
      "eve-5-outside-params-bind-group",
    );

    const pass = new RenderPass(device, {
      label: "eve-5-scene-hdr-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, isLight ? 0 : 1] }],
    });

    // Optional environment background: draw the studio cubemap behind the logo so the lighting
    // is visible. Fullscreen triangle, no vertex buffer, so do it before binding the mesh.
    if (controls.showEnv) {
      pass.setPipeline(envBgPipeline);
      pass.setBindGroup(0, envBgParams.bindGroup);
      pass.draw(3);
    }

    pass.setVertexBuffer(0, gpuMesh.vertexBuffer);

    const needsBackTargets = controls.material === "glass" || controls.material === "thickness";
    pass.gpu.setIndexBuffer(gpuMesh.indexBuffer.gpu, "uint32");
    if (needsBackTargets) {
      // The back/inside material and camera-axis depth have already been rendered into offscreen
      // targets. The main scene draws only the front/outside material; glass and thickness debug
      // both need the real back targets rather than the opaque/debug fallback bind group.
      if (controls.outsideRendering) {
        pass.setPipeline(frontMaterialPipeline);
        pass.setBindGroup(0, outsideBindGroup);
        pass.gpu.drawIndexed(gpuMesh.indexCount, 1, 0, 0, 0);
      }
    } else if (controls.outsideRendering) {
      // Opaque/debug materials are single-surface views. Drawing the inside pass too would
      // double-expose through the depthless transparent ordering used by glass.
      pass.setPipeline(opaquePipeline);
      pass.setBindGroup(0, opaqueOutsideParams.bindGroup);
      pass.gpu.drawIndexed(gpuMesh.indexCount, 1, 0, 0, 0);
    }

    if (controls.wireframe) {
      pass.setPipeline(wirePipeline);
      pass.gpu.setIndexBuffer(gpuMesh.lineIndexBuffer.gpu, "uint32");
      pass.setBindGroup(0, wireParams.bindGroup);
      pass.gpu.drawIndexed(gpuMesh.lineIndexCount, 1, 0, 0, 0);
    }

    pass.end();
  };

  const renderTargetPreview = (view: GPUTextureView, targets: BloomTargets, controls: RenderControls) => {
    const basis = cameraBasis(orbitEye(orbitTarget, controls.radius, controls.yaw, controls.pitch), orbitTarget);
    const depthRange = cameraAxisDepthRange(mesh.bounds, basis.forward);
    previewMode.write(
      new Float32Array([
        controls.material === "back-depth" ? PREVIEW_BACK_DEPTH : PREVIEW_BACK_ALBEDO,
        depthRange.min,
        depthRange.max,
        0,
      ]),
    );
    const bindGroup = device.gpu.createBindGroup({
      label: "eve-5-render-target-preview-bind-group",
      layout: previewPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: targets.backMaterial.createView() },
        { binding: 1, resource: targets.backDepth.createView() },
        { binding: 2, resource: previewSampler },
        { binding: 3, resource: { buffer: previewMode.gpu } },
      ],
    });
    const pass = new RenderPass(device, {
      label: "eve-5-render-target-preview-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(previewPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const renderThicknessDebug = (view: GPUTextureView, backMaterial: GPUTexture, backDepth: GPUTexture, controls: RenderControls, logicalWidth: number, logicalHeight: number) => {
    writeParams(outsideParams, controls, logicalWidth, logicalHeight, PASS_OUTSIDE);
    const outsideBindGroup = createParamsBindGroup(
      device,
      frontDisplayPipeline,
      studioCubemap,
      outsideParams.buffer,
      backMaterial.createView(),
      backDepth.createView(),
      "eve-5-thickness-debug-params-bind-group",
    );

    const pass = new RenderPass(device, {
      label: "eve-5-thickness-debug-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setVertexBuffer(0, gpuMesh.vertexBuffer);
    pass.gpu.setIndexBuffer(gpuMesh.indexBuffer.gpu, "uint32");
    if (controls.outsideRendering) {
      pass.setPipeline(frontDisplayPipeline);
      pass.setBindGroup(0, outsideBindGroup);
      pass.gpu.drawIndexed(gpuMesh.indexCount, 1, 0, 0, 0);
    }
    pass.end();
  };

  const renderBlur = (source: GPUTexture, target: GPUTexture, direction: [number, number], extract: boolean) => {
    blurParamsBuffer.write(new Float32Array([direction[0], direction[1], extract ? 1 : 0, BLOOM_THRESHOLD]));
    const bindGroup = device.gpu.createBindGroup({
      label: "eve-5-bloom-blur-bind-group",
      layout: blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: blurSampler },
        { binding: 2, resource: { buffer: blurParamsBuffer.gpu } },
      ],
    });
    const pass = new RenderPass(device, {
      label: `eve-5-bloom-${direction[0] > 0 ? "horizontal" : "vertical"}-pass`,
      colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(blurPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const renderComposite = (view: GPUTextureView, targets: BloomTargets) => {
    const bindGroup = device.gpu.createBindGroup({
      label: "eve-5-bloom-composite-bind-group",
      layout: compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: targets.scene.createView() },
        { binding: 1, resource: targets.vertical.createView() },
        { binding: 2, resource: blurSampler },
        { binding: 3, resource: { buffer: compositeParamsBuffer.gpu } },
      ],
    });
    const pass = new RenderPass(device, {
      label: "eve-5-composite-tonemap-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(compositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  const renderLightComposite = (view: GPUTextureView, targets: BloomTargets) => {
    const bindGroup = device.gpu.createBindGroup({
      label: "eve-5-light-composite-bind-group",
      layout: lightCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: targets.scene.createView() },
        { binding: 1, resource: blurSampler },
      ],
    });
    const pass = new RenderPass(device, {
      label: "eve-5-light-composite-premultiplied-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(lightCompositePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  };

  return {
    render(target: GPUTextureView, controls: RenderControls, logicalWidth: number, logicalHeight: number) {
      const safeWidth = Math.max(1, Math.round(logicalWidth));
      const safeHeight = Math.max(1, Math.round(logicalHeight));
      const targets = ensureBloomTargets(safeWidth, safeHeight);
      const backSurfaceDepthView = targets.backSurfaceDepth.createView();
      renderBackMaterial(targets.backMaterial.createView(), backSurfaceDepthView, controls, safeWidth, safeHeight);
      renderBackDepth(targets.backDepth.createView(), backSurfaceDepthView, controls, safeWidth, safeHeight);
      if (controls.material === "back-albedo" || controls.material === "back-depth") {
        renderTargetPreview(target, targets, controls);
        return;
      }
      if (controls.material === "thickness") {
        renderThicknessDebug(target, targets.backMaterial, targets.backDepth, controls, safeWidth, safeHeight);
        return;
      }
      renderScene(targets.scene.createView(), targets.backMaterial, targets.backDepth, controls, safeWidth, safeHeight);
      if (isLight) {
        renderLightComposite(target, targets);
        return;
      }
      renderBlur(targets.scene, targets.horizontal, [1, 0], true);
      renderBlur(targets.horizontal, targets.vertical, [0, 1], false);
      renderComposite(target, targets);
    },
    dispose() {
      gpuMesh.vertexBuffer.destroy();
      gpuMesh.indexBuffer.destroy();
      gpuMesh.lineIndexBuffer.destroy();
      insideParams.buffer.destroy();
      backDepthParams.buffer.destroy();
      outsideParams.buffer.destroy();
      outsideParams.fallbackBackMaterial.destroy();
      outsideParams.fallbackBackDepth.destroy();
      opaqueOutsideParams.buffer.destroy();
      opaqueOutsideParams.fallbackBackMaterial.destroy();
      opaqueOutsideParams.fallbackBackDepth.destroy();
      wireParams.buffer.destroy();
      wireParams.fallbackBackMaterial.destroy();
      wireParams.fallbackBackDepth.destroy();
      envBgParams.buffer.destroy();
      blurParamsBuffer.destroy();
      compositeParamsBuffer.destroy();
      previewMode.destroy();
      bloomTargets?.scene.destroy();
      bloomTargets?.backMaterial.destroy();
      bloomTargets?.backDepth.destroy();
      bloomTargets?.backSurfaceDepth.destroy();
      bloomTargets?.horizontal.destroy();
      bloomTargets?.vertical.destroy();
      studioCubemap.faceParams.destroy();
      studioCubemap.texture.destroy();
    },
  };
}

type BloomTargets = {
  width: number;
  height: number;
  scene: GPUTexture;
  backMaterial: GPUTexture;
  backDepth: GPUTexture;
  backSurfaceDepth: GPUTexture;
  horizontal: GPUTexture;
  vertical: GPUTexture;
};

export function getPaddedRenderSize(width: number, height: number) {
  return {
    width: Math.max(1, Math.round(width)) + BLOOM_RADIUS * 2,
    height: Math.max(1, Math.round(height)) + BLOOM_RADIUS * 2,
  };
}

function createBloomTexture(device: Device, label: string, width: number, height: number) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: SCENE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

function createBackDepthTexture(device: Device, label: string, width: number, height: number) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: BACK_DEPTH_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

export function createStudioCubemap(device: Device): StudioCubemap {
  const texture = device.gpu.createTexture({
    label: "eve-5-studio-hdr-cubemap",
    size: { width: CUBE_SIZE, height: CUBE_SIZE, depthOrArrayLayers: CUBE_FACE_COUNT },
    dimension: "2d",
    format: CUBE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  // Dawn's node adapter runs in compatibility mode and validates cube views as 2D arrays.
  // Keep the asset semantically as a cubemap, but bind/sample it as six array layers.
  const view = texture.createView({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: CUBE_FACE_COUNT });
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

export function renderStudioCubemap(device: Device, cubemap: StudioCubemap) {
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
    cubemap.faceParams.write(new Float32Array([face, 0, 0, 0]));
    const pass = new RenderPass(device, {
      label: `eve-5-studio-cubemap-face-${face}`,
      colorAttachments: [
        {
          view: cubemap.texture.createView({ dimension: "2d", baseArrayLayer: face, arrayLayerCount: 1 }),
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

function createEnvParamsBinding(device: Device, pipeline: GPURenderPipeline, cubemap: StudioCubemap, label: string) {
  const buffer = device.createBuffer({ size: PARAMS_BYTE_SIZE, usage: ["uniform", "copy_dst"], label });
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

function createBackParamsBinding(device: Device, pipeline: GPURenderPipeline, cubemap: StudioCubemap, label: string) {
  const buffer = device.createBuffer({ size: PARAMS_BYTE_SIZE, usage: ["uniform", "copy_dst"], label });
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

function createUniformParamsBinding(device: Device, pipeline: GPURenderPipeline, label: string) {
  const buffer = device.createBuffer({ size: PARAMS_BYTE_SIZE, usage: ["uniform", "copy_dst"], label });
  const bindGroup = device.gpu.createBindGroup({
    label: `${label}-bind-group`,
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: buffer.gpu } }],
  });
  return { buffer, bindGroup };
}

function createParamsBinding(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  label: string,
  backMaterialView?: GPUTextureView,
  backDepthView?: GPUTextureView,
) {
  const buffer = device.createBuffer({ size: PARAMS_BYTE_SIZE, usage: ["uniform", "copy_dst"], label });
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
  const bindGroup = createParamsBindGroup(
    device,
    pipeline,
    cubemap,
    buffer,
    backMaterialView ?? fallbackBackMaterial.createView(),
    backDepthView ?? fallbackBackDepth.createView(),
    `${label}-bind-group`,
  );
  return { buffer, bindGroup, fallbackBackMaterial, fallbackBackDepth };
}

function createParamsBindGroup(
  device: Device,
  pipeline: GPURenderPipeline,
  cubemap: StudioCubemap,
  buffer: Buffer,
  backMaterialView: GPUTextureView,
  backDepthView: GPUTextureView,
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
    ],
  });
}

function createGpuMesh(device: Device, mesh: MeshData): GpuMesh {
  const vertices = normalizeMeshForGpu(mesh);
  const lineIndices = triangleIndicesToLineIndices(mesh.indices);

  const vertexBuffer = device.createBuffer({
    label: "eve-5-logo-vertices",
    size: vertices.byteLength,
    usage: ["vertex", "copy_dst"],
  });
  vertexBuffer.write(vertices);

  const indexBuffer = device.createBuffer({
    label: "eve-5-logo-indices",
    size: mesh.indices.byteLength,
    usage: ["index", "copy_dst"],
  });
  indexBuffer.write(new Uint32Array(mesh.indices));

  const lineIndexBuffer = device.createBuffer({
    label: "eve-5-logo-line-indices",
    size: lineIndices.byteLength,
    usage: ["index", "copy_dst"],
  });
  lineIndexBuffer.write(lineIndices);

  return {
    vertexBuffer,
    indexBuffer,
    lineIndexBuffer,
    indexCount: mesh.indices.length,
    lineIndexCount: lineIndices.length,
  };
}

function normalizeMeshForGpu(mesh: MeshData) {
  const height = mesh.bounds.max[1] - mesh.bounds.min[1];
  const centerX = (mesh.bounds.min[0] + mesh.bounds.max[0]) * 0.5;
  const centerY = (mesh.bounds.min[1] + mesh.bounds.max[1]) * 0.5;
  const frontZ = mesh.bounds.max[2];
  const data = new Float32Array((mesh.positions.length / 3) * 6);

  for (let i = 0, j = 0; i < mesh.positions.length; i += 3, j += 6) {
    data[j] = (mesh.positions[i]! - centerX) / height;
    data[j + 1] = (mesh.positions[i + 1]! - centerY) / height;
    data[j + 2] = (mesh.positions[i + 2]! - frontZ) / height;
    data[j + 3] = mesh.normals[i]!;
    data[j + 4] = mesh.normals[i + 1]!;
    data[j + 5] = mesh.normals[i + 2]!;
  }

  return data;
}

function triangleIndicesToLineIndices(indices: Uint32Array) {
  const lines = new Uint32Array(indices.length * 2);
  for (let i = 0, j = 0; i < indices.length; i += 3, j += 6) {
    const a = indices[i]!;
    const b = indices[i + 1]!;
    const c = indices[i + 2]!;
    lines[j] = a;
    lines[j + 1] = b;
    lines[j + 2] = b;
    lines[j + 3] = c;
    lines[j + 4] = c;
    lines[j + 5] = a;
  }
  return lines;
}

function meshOrbitTarget(mesh: MeshData): Vec3 {
  const height = mesh.bounds.max[1] - mesh.bounds.min[1] || 1;
  const depth = mesh.bounds.max[2] - mesh.bounds.min[2];
  return [0, 0, -depth / (height * 2)];
}

export function meshThicknessScale(bounds: Bounds) {
  // The shader computes camera-axis depth from the normalized GPU mesh coordinates created in
  // normalizeMeshForGpu(...), not raw glTF/model units. Keep the real EVE logo normalization in the
  // same coordinate space; otherwise the tiny raw Z extent clamps the thickness debug to white.
  const height = bounds.max[1] - bounds.min[1] || 1;
  const normalizedZExtent = (bounds.max[2] - bounds.min[2]) / height;
  return Math.max(normalizedZExtent * EVE_THICKNESS_SCALE_MULTIPLIER, 0.000001);
}

function cameraAxisDepthRange(bounds: Bounds, forward: Vec3) {
  const corners: Vec3[] = [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]],
  ];
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const corner of corners) {
    const depth = dot(normalizePositionForGpu(corner, bounds), forward);
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { min: minDepth, max: maxDepth };
}

function normalizePositionForGpu(position: Vec3, bounds: Bounds): Vec3 {
  const height = bounds.max[1] - bounds.min[1] || 1;
  const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
  const centerY = (bounds.min[1] + bounds.max[1]) * 0.5;
  const frontZ = bounds.max[2];
  return [(position[0] - centerX) / height, (position[1] - centerY) / height, (position[2] - frontZ) / height];
}

function orbitEye(target: Vec3, radius: number, yawRadians: number, pitchRadians: number): Vec3 {
  const cp = Math.cos(pitchRadians);
  return [
    target[0] + radius * cp * Math.sin(yawRadians),
    target[1] + radius * Math.sin(pitchRadians),
    target[2] + radius * cp * Math.cos(yawRadians),
  ];
}

function cameraBasis(eye: Vec3, target: Vec3) {
  const forward = normalize(sub(target, eye));
  const upRef: Vec3 = Math.abs(dot(forward, [0, 1, 0])) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, upRef));
  const up = cross(right, forward);
  return { forward, right, up };
}

function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  let x = cross(up, z);
  if (length(x) < 1e-6) {
    x = cross([0, 0, 1], z);
    if (length(x) < 1e-6) x = cross([1, 0, 0], z);
  }
  x = normalize(x);
  const y = cross(z, x);

  const m = new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[3] = 0;
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[7] = 0;
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[11] = 0;
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}
