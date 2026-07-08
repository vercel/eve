import { resolve } from "node:path";
import { mobileAutoEnvYaw } from "../../app/[lang]/(home)/components/eve-logo-shader/mobile-motion";
import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH_OFF,
  BLOOM_STRENGTH_ON,
  BLOOM_THRESHOLD,
  DEFAULT_CAMERA_FOV,
  DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  DEFAULT_PAINT_BRUSH_RADIUS,
  DEFAULT_PAINT_BRUSH_STRENGTH,
  DEFAULT_PAINT_DECAY_PER_FRAME_120,
  DEFAULT_PAINT_DIFFUSION_JITTER,
  DEFAULT_PAINT_DIFFUSION_RATE,
  DEFAULT_PAINT_DT,
  cameraRadiusForFov,
  getPaddedRenderSize,
  type EveMaterial,
  type RenderControls,
} from "../../app/[lang]/(home)/components/eve-logo-shader/render";
import {
  readBooleanEnv,
  readFiniteNumberEnv,
  readNonNegativeIntegerEnv,
  readNonNegativeNumberEnv,
  readOptionalFiniteNumberEnv,
  readOptionalPositiveNumberEnv,
  readPositiveIntegerEnv,
  readPositiveNumberEnv,
  readRangeEnv,
  readRenderStageEnv,
  readThemeEnv,
  readUnitIntervalEnv,
} from "./env";

// Owns env-to-render-config assembly for the offline Eve renderer.
// INVARIANT: defaults and eager CLI semantics match the original script.
// Imported only by render-eve-5.ts and helper modules.

export const FORMAT: GPUTextureFormat = "rgba8unorm";

export type RenderConfig = ReturnType<typeof readRenderConfig>;

export function readRenderConfig() {
  const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const outDir = resolve(process.cwd(), "tmp/eve-5-renders", runId);
  const paddingRadius = readNonNegativeIntegerEnv("EVE_LOGO_RENDER_PADDING", 0);
  const bloomEnabled = readBooleanEnv("EVE_LOGO_RENDER_BLOOM", false);
  const outputWidth = readPositiveIntegerEnv("EVE_LOGO_RENDER_WIDTH", 1095, paddingRadius * 2);
  const outputHeight = readPositiveIntegerEnv("EVE_LOGO_RENDER_HEIGHT", 348, paddingRadius * 2);
  const logicalWidth = Math.max(1, outputWidth - paddingRadius * 2);
  const logicalHeight = Math.max(1, outputHeight - paddingRadius * 2);
  const paddedSize = getPaddedRenderSize(logicalWidth, logicalHeight, paddingRadius);
  const width = paddedSize.width;
  const height = paddedSize.height;
  const theme = readThemeEnv();
  const dpr = readPositiveNumberEnv("EVE_LOGO_RENDER_DPR", DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO);
  const imprintProgress = readUnitIntervalEnv("EVE_LOGO_RENDER_IMPRINT_PROGRESS");
  const imprintGridScaleMultiplier = readPositiveNumberEnv(
    "EVE_LOGO_IMPRINT_GRID_SCALE_MULTIPLIER",
    DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  );
  const imprintGlyphScale = readPositiveNumberEnv("EVE_LOGO_IMPRINT_GLYPH_SCALE", 1.35);
  const requestedRenderStage = readRenderStageEnv();
  const renderStage: EveMaterial = requestedRenderStage;
  const paintSteps = readNonNegativeIntegerEnv("EVE_LOGO_PAINT_STEPS", 0);
  const paintDecayPerFrame120 = readPositiveNumberEnv(
    "EVE_LOGO_PAINT_DECAY_PER_FRAME_120",
    DEFAULT_PAINT_DECAY_PER_FRAME_120,
  );
  const paintDecayRate =
    readOptionalPositiveNumberEnv("EVE_LOGO_PAINT_DECAY_RATE") ?? paintDecayPerFrame120 * 120;
  const paintDiffusionRate = readNonNegativeNumberEnv(
    "EVE_LOGO_PAINT_DIFFUSION",
    DEFAULT_PAINT_DIFFUSION_RATE,
  );
  const paintDiffusionJitter = readRangeEnv(
    "EVE_LOGO_PAINT_DIFFUSION_JITTER",
    DEFAULT_PAINT_DIFFUSION_JITTER,
    0,
    4,
  );
  const paintBrushRadius = readPositiveNumberEnv(
    "EVE_LOGO_PAINT_BRUSH_RADIUS",
    DEFAULT_PAINT_BRUSH_RADIUS,
  );
  const paintBrushStrength = readNonNegativeNumberEnv(
    "EVE_LOGO_PAINT_BRUSH_STRENGTH",
    DEFAULT_PAINT_BRUSH_STRENGTH,
  );
  const paintDt = readPositiveNumberEnv("EVE_LOGO_PAINT_DT", DEFAULT_PAINT_DT);
  const paintDecaySteps = readNonNegativeIntegerEnv("EVE_LOGO_PAINT_DECAY_STEPS", 0);
  const renderYaw = readFiniteNumberEnv("EVE_LOGO_RENDER_YAW", 0);
  const renderEnvYawTime = readOptionalFiniteNumberEnv("EVE_LOGO_ENV_YAW_TIME");
  const renderEnvYaw =
    readOptionalFiniteNumberEnv("EVE_LOGO_RENDER_ENV_YAW") ??
    (renderEnvYawTime === undefined ? 0 : mobileAutoEnvYaw(renderEnvYawTime));
  const modelPath = resolve(process.cwd(), "public/eve-5/eve-logo.gltf");
  const defaultControls: RenderControls = {
    yaw: renderYaw,
    pitch: 0,
    radius: cameraRadiusForFov(DEFAULT_CAMERA_FOV),
    fov: DEFAULT_CAMERA_FOV,
    envYaw: renderEnvYaw,
    envPitch: 0,
    insideRendering: true,
    outsideRendering: true,
    material: renderStage,
    wireframe: false,
    showEnv: false,
  };

  return {
    runId,
    outDir,
    format: FORMAT,
    paddingRadius,
    bloomEnabled,
    outputWidth,
    outputHeight,
    logicalWidth,
    logicalHeight,
    width,
    height,
    theme,
    dpr,
    imprintProgress,
    imprintGridScaleMultiplier,
    imprintGlyphScale,
    requestedRenderStage,
    renderStage,
    paintSteps,
    paintDecayPerFrame120,
    paintDecayRate,
    paintDiffusionRate,
    paintDiffusionJitter,
    paintBrushRadius,
    paintBrushStrength,
    paintDt,
    paintDecaySteps,
    renderYaw,
    renderEnvYawTime,
    renderEnvYaw,
    modelPath,
    defaultControls,
    bloomConstants: {
      radius: BLOOM_RADIUS,
      strengthOff: BLOOM_STRENGTH_OFF,
      strengthOn: BLOOM_STRENGTH_ON,
      threshold: BLOOM_THRESHOLD,
    },
  };
}

export function effectiveBloomStrength(config: RenderConfig, imprintProgress: number) {
  return (
    config.bloomConstants.strengthOff +
    (config.bloomConstants.strengthOn - config.bloomConstants.strengthOff) * imprintProgress
  );
}
