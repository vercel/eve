// Renderer domain types and GPU resource shapes.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type { Buffer } from "@vgpu/core";

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

export type EveMaterial =
  | "glass"
  | "normal"
  | "camera reflected normal"
  | "metallic"
  | "back-albedo"
  | "back-depth"
  | "thickness"
  | "paint-debug";

export type PaintSeed = {
  width: number;
  height: number;
  values: Float32Array;
};

export type PaintStroke = {
  fromCell: readonly [number, number];
  toCell: readonly [number, number];
  duration?: number;
  movementGated?: boolean;
};

export type PaintRenderOptions = {
  seed?: PaintSeed;
  steps?: number;
  dt?: number;
  brushCell?: readonly [number, number];
  brushPreviousCell?: readonly [number, number];
  brushRadius?: number;
  brushStrength?: number;
  brushActive?: boolean;
  decayRate?: number;
  diffusionRate?: number;
  diffusionJitter?: number;
  stroke?: PaintStroke;
  decaySteps?: number;
};

export type ImprintRenderOptions = {
  progress?: number;
  gridScaleMultiplier?: number;
  glyphScale?: number;
  time?: number;
  mouse?: readonly [number, number];
  paint?: PaintRenderOptions;
  devicePixelRatio?: number;
};

export type RenderControls = {
  yaw: number;
  pitch: number;
  radius: number;
  fov: number;
  envYaw: number;
  envPitch: number;
  insideRendering: boolean;
  outsideRendering: boolean;
  material: EveMaterial;
  wireframe: boolean;
  showEnv: boolean;
};

export type PaintPointerRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PaintPointerMappingInput = {
  clientX: number;
  clientY: number;
  rect: PaintPointerRect;
  canvasWidth: number;
  canvasHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  controls: Pick<RenderControls, "radius" | "yaw" | "pitch" | "fov">;
  meshBounds: Bounds;
  gridScaleMultiplier?: number;
  paddingRadius?: number;
  devicePixelRatio?: number;
};

export type PaintPointerMapping = {
  physical: readonly [number, number];
  logical: readonly [number, number];
  model: readonly [number, number];
  brushCell: readonly [number, number];
  originCell: readonly [number, number];
  gridScale: number;
  pxPerModelUnit: number;
  insideLogicalBounds: boolean;
};

export type GpuMesh = {
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

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export type EnvLightConfig = {
  name: string;
  position: readonly [number, number, number];
  color: string;
  intensity: number;
  radius: number;
  softness: number;
  luminance: number;
};

export type BloomTargets = {
  width: number;
  height: number;
  scene: GPUTexture;
  backMaterial: GPUTexture;
  backDepth: GPUTexture;
  backSurfaceDepth: GPUTexture;
  horizontal: GPUTexture;
  vertical: GPUTexture;
};

export type PaintTargets = {
  cols: number;
  rows: number;
  ping: GPUTexture;
  pong: GPUTexture;
  staticNoise: GPUTexture;
  voronoiValue: GPUTexture;
  voronoiEdge: GPUTexture;
  readIsPing: boolean;
  pingReadBindGroup: GPUBindGroup;
  pongReadBindGroup: GPUBindGroup;
  pingDebugBindGroup: GPUBindGroup;
  pongDebugBindGroup: GPUBindGroup;
};
