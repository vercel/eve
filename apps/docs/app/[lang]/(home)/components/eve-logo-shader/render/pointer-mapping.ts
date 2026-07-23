// Pointer-to-paint-cell mapping; mirrors params origin-cell math.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type {
  Bounds,
  PaintPointerMapping,
  PaintPointerMappingInput,
  RenderControls,
} from "./types";
import {
  BLOOM_RADIUS,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  imprintCellSizeForLogicalHeight,
} from "./constants";
import { meshOrbitTargetFromBounds } from "./camera";
import { degreesToRadians, dot } from "./math";
import { getPaddedRenderSize } from "./textures";
import { cameraBasis, orbitEye } from "./math";
import { normalizedMeshBounds } from "./mesh-gpu";

export function mapClientPointToPaintCell(
  input: PaintPointerMappingInput,
): PaintPointerMapping | undefined {
  const rectWidth = Math.max(0, input.rect.width);
  const rectHeight = Math.max(0, input.rect.height);
  const canvasWidth = Math.max(1, input.canvasWidth);
  const canvasHeight = Math.max(1, input.canvasHeight);
  const logicalWidth = Math.max(1, Math.round(input.logicalWidth));
  const logicalHeight = Math.max(1, Math.round(input.logicalHeight));
  if (rectWidth <= 0 || rectHeight <= 0) return undefined;

  const paddingRadius = input.paddingRadius ?? BLOOM_RADIUS;
  const xPhys = (input.clientX - input.rect.left) * (canvasWidth / rectWidth);
  const yPhys = (input.clientY - input.rect.top) * (canvasHeight / rectHeight);
  const xLog = xPhys - paddingRadius;
  const yLog = yPhys - paddingRadius;
  const metrics = paintMappingMetrics(
    input.meshBounds,
    input.controls,
    logicalWidth,
    logicalHeight,
    input.gridScaleMultiplier ?? DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
    paddingRadius,
    input.devicePixelRatio,
  );
  const modelX = (xLog - logicalWidth * 0.5) / metrics.pxPerModelUnit;
  const modelY = (logicalHeight * 0.5 - yLog) / metrics.pxPerModelUnit;
  const brushCellX = modelX * metrics.gridScale - metrics.originCell[0];
  const brushCellY = modelY * metrics.gridScale - metrics.originCell[1];
  return {
    physical: [xPhys, yPhys],
    logical: [xLog, yLog],
    model: [modelX, modelY],
    brushCell: [brushCellX, brushCellY],
    originCell: metrics.originCell,
    gridScale: metrics.gridScale,
    pxPerModelUnit: metrics.pxPerModelUnit,
    insideLogicalBounds: xLog >= 0 && xLog <= logicalWidth && yLog >= 0 && yLog <= logicalHeight,
  };
}

export function paintMappingMetrics(
  bounds: Bounds,
  controls: Pick<RenderControls, "radius" | "yaw" | "pitch" | "fov">,
  logicalWidth: number,
  logicalHeight: number,
  gridScaleMultiplier: number,
  paddingRadius: number,
  _devicePixelRatio?: number,
) {
  const padded = getPaddedRenderSize(logicalWidth, logicalHeight, paddingRadius);
  const fovRad = degreesToRadians(controls.fov);
  const verticalScale = padded.height / Math.max(1, logicalHeight);
  const fovEff = 2 * Math.atan(verticalScale * Math.tan(fovRad * 0.5));
  const orbitTarget = meshOrbitTargetFromBounds(bounds);
  const eye = orbitEye(orbitTarget, controls.radius, controls.yaw, controls.pitch);
  const basis = cameraBasis(eye, orbitTarget);
  const distToFrontPlane = Math.max(0.001, -dot(eye, basis.forward));
  const pxPerModelUnit = padded.height / (2 * distToFrontPlane * Math.tan(fovEff * 0.5));
  const cellSize = imprintCellSizeForLogicalHeight(logicalHeight);
  const gridScale = (pxPerModelUnit / cellSize) * Math.max(0.001, gridScaleMultiplier);
  const normalizedBounds = normalizedMeshBounds(bounds);
  const originCell: [number, number] = [
    Math.floor(normalizedBounds.min[0] * gridScale),
    Math.floor(normalizedBounds.min[1] * gridScale),
  ];
  return { gridScale, originCell, pxPerModelUnit };
}
