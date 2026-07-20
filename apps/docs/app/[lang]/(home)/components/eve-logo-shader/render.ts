// Pure facade for the Eve hero renderer.
// INVARIANT: External imports continue to target this file; implementation lives under render/.
// Re-export only stable renderer API names and types.

export { createEve5Renderer } from "./render/renderer";
export { mapClientPointToPaintCell } from "./render/pointer-mapping";
export { getPaddedRenderSize } from "./render/textures";
export { cameraRadiusForFov } from "./render/math";
export { meshThicknessScale } from "./render/camera";
export { createStudioCubemap, renderStudioCubemap } from "./render/cubemap";
export { EVE_DARK_ENV_LIGHTS, EVE_LIGHT_ENV_LIGHTS } from "./render/env-lights";
export {
  BLOOM_RADIUS,
  BLOOM_STRENGTH_OFF,
  BLOOM_STRENGTH_ON,
  BLOOM_THRESHOLD,
  bloomRadiusForDevicePixelRatio,
  DEFAULT_CAMERA_FOV,
  DEFAULT_IMPRINT_CELL_SIZE,
  DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  DEFAULT_PAINT_BRUSH_RADIUS,
  DEFAULT_PAINT_BRUSH_STRENGTH,
  DEFAULT_PAINT_DECAY_PER_FRAME_120,
  DEFAULT_PAINT_DIFFUSION_JITTER,
  DEFAULT_PAINT_DIFFUSION_RATE,
  DEFAULT_PAINT_DT,
  imprintCellSizeForDevicePixelRatio,
  imprintCellSizeForLogicalHeight,
  imprintGridSizeForLogicalSize,
} from "./render/constants";
export type {
  Bounds,
  EnvLightConfig,
  EveMaterial,
  ImprintRenderOptions,
  MeshData,
  PaintPointerMapping,
  PaintPointerMappingInput,
  PaintPointerRect,
  PaintRenderOptions,
  PaintSeed,
  PaintStroke,
  RenderControls,
  StudioCubemap,
} from "./render/types";
