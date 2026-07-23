import {
  imprintGridSizeForLogicalSize,
  type PaintRenderOptions,
  type PaintSeed,
} from "../../app/[lang]/(home)/components/eve-logo-shader/render";
import type { RenderConfig } from "./config";
import { readBooleanEnv } from "./env";

// Owns deterministic paint seed/stroke fixtures for offline renders.
// INVARIANT: cell sizing and env grammar preserve legacy output pixels.
// Imported by views and render-eve-5.ts reporting.

export function paintRequested() {
  return Boolean(
    process.env.EVE_LOGO_PAINT_BLOB ||
    process.env.EVE_LOGO_PAINT_PATTERN ||
    process.env.EVE_LOGO_PAINT_STROKE,
  );
}

export function buildPaintSeed(config: RenderConfig): PaintSeed | undefined {
  if (!paintRequested()) return undefined;
  const { cols: width, rows: height } = imprintGridSizeForLogicalSize(
    config.logicalWidth,
    config.logicalHeight,
    config.imprintGridScaleMultiplier,
  );
  const values = new Float32Array(width * height);
  const pattern = process.env.EVE_LOGO_PAINT_PATTERN;
  if (pattern) {
    fillPaintPattern(values, width, height, pattern);
  }
  const blob = process.env.EVE_LOGO_PAINT_BLOB;
  if (blob) {
    for (const part of blob.split(/[;|]/)) {
      if (part.trim()) addPaintBlob(values, width, height, part.trim());
    }
  }
  return { width, height, values };
}

export function paintOptions(config: RenderConfig, seed: PaintSeed): PaintRenderOptions {
  return {
    seed,
    steps: config.paintSteps,
    decaySteps: config.paintDecaySteps,
    dt: config.paintDt,
    brushRadius: config.paintBrushRadius,
    brushStrength: config.paintBrushStrength,
    brushActive: false,
    decayRate: config.paintDecayRate,
    diffusionRate: config.paintDiffusionRate,
    diffusionJitter: config.paintDiffusionJitter,
    stroke: readPaintStroke(seed.width, seed.height),
  };
}

export function readPaintStroke(width: number, height: number): PaintRenderOptions["stroke"] {
  const spec = process.env.EVE_LOGO_PAINT_STROKE;
  if (!spec) return undefined;
  const parts = spec.split(",").map((value) => Number.parseFloat(value));
  if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error('EVE_LOGO_PAINT_STROKE must be "x0,y0,x1,y1,duration".');
  }
  const [x0, y0, x1, y1, duration] = parts as [number, number, number, number, number];
  if (duration <= 0) throw new Error("EVE_LOGO_PAINT_STROKE duration must be positive.");
  return {
    fromCell: [x0 * width, y0 * height],
    toCell: [x1 * width, y1 * height],
    duration,
    movementGated: readBooleanEnv("EVE_LOGO_PAINT_STROKE_MOVEMENT_GATED", true),
  };
}

function fillPaintPattern(values: Float32Array, width: number, height: number, pattern: string) {
  if (pattern === "full") {
    values.fill(1);
    return;
  }
  if (pattern === "ramp") {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) values[y * width + x] = width <= 1 ? 1 : x / (width - 1);
    }
    return;
  }
  if (pattern === "stripes") {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) values[y * width + x] = x % 2 === 0 ? 1 : 0;
    }
    return;
  }
  throw new Error('EVE_LOGO_PAINT_PATTERN must be "stripes", "ramp", or "full".');
}

function addPaintBlob(values: Float32Array, width: number, height: number, spec: string) {
  const parts = spec.split(",").map((value) => Number.parseFloat(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error('EVE_LOGO_PAINT_BLOB entries must be "x,y,radius,intensity".');
  }
  const [x, y, radius, intensity] = parts as [number, number, number, number];
  if (radius <= 0) throw new Error("EVE_LOGO_PAINT_BLOB radius must be positive.");
  const centerX = x * width;
  const centerY = y * height;
  const radiusCells = radius * Math.max(width, height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const dx = col + 0.5 - centerX;
      const dy = row + 0.5 - centerY;
      const d = Math.hypot(dx, dy);
      const falloff = 1 - smoothstep(0, radiusCells, d);
      const index = row * width + col;
      values[index] = Math.max(values[index] ?? 0, Math.max(0, Math.min(1, intensity * falloff)));
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(edge1 - edge0, 0.000001)));
  return t * t * (3 - 2 * t);
}
