// TS-side uniform ABI writer for shared scene params.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type { Buffer } from "@vgpu/core";
import {
  DEFAULT_IMPRINT_GLYPH_SCALE,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  MATERIAL_KIND,
} from "./constants";
import { cameraClipPlanes } from "./camera";
import { cameraBasis, degreesToRadians, lookAt, multiply, orbitEye, perspective } from "./math";
import { getPaddedRenderSize } from "./textures";
import { paintMappingMetrics } from "./pointer-mapping";
import type { Bounds, ImprintRenderOptions, RenderControls, Vec3 } from "./types";

// ABI: must match shaders/shared/scene-params.wgsl (176 B / 44 f32).
export function writeParams(args: {
  target: { buffer: Buffer };
  controls: RenderControls;
  logicalWidth: number;
  logicalHeight: number;
  passKind: number;
  projectionPaddingRadius: number;
  imprint?: ImprintRenderOptions;
  meshBounds: Bounds;
  orbitTarget: Vec3;
  thicknessScale: number;
  isLight: boolean;
}) {
  const {
    target,
    controls,
    logicalWidth,
    logicalHeight,
    passKind,
    projectionPaddingRadius,
    imprint = {},
    meshBounds,
    orbitTarget,
    thicknessScale,
    isLight,
  } = args;
  const padded = getPaddedRenderSize(logicalWidth, logicalHeight, projectionPaddingRadius);
  const fovRad = degreesToRadians(controls.fov);
  const verticalScale = padded.height / logicalHeight;
  const fovEff = 2 * Math.atan(verticalScale * Math.tan(fovRad * 0.5));
  const aspect = padded.width / padded.height;
  const eye = orbitEye(orbitTarget, controls.radius, controls.yaw, controls.pitch);
  const basis = cameraBasis(eye, orbitTarget);
  const clip = cameraClipPlanes(meshBounds, eye, basis.forward);
  const proj = perspective(fovEff, aspect, clip.near, clip.far);
  const view = lookAt(eye, orbitTarget, [0, 1, 0]);
  const viewProj = multiply(proj, view);
  const data = new Float32Array(44);
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
  data[34] = controls.envPitch;
  data[35] = isLight ? 0 : 1;
  const metrics = paintMappingMetrics(
    meshBounds,
    controls,
    logicalWidth,
    logicalHeight,
    imprint.gridScaleMultiplier ?? DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
    projectionPaddingRadius,
    imprint.devicePixelRatio,
  );
  const gridScale = metrics.gridScale;
  data[36] = Math.max(0, Math.min(1, imprint.progress ?? 0));
  data[37] = gridScale;
  data[38] = Math.max(0.1, imprint.glyphScale ?? DEFAULT_IMPRINT_GLYPH_SCALE);
  data[39] = imprint.time ?? 0;
  data[40] = imprint.mouse?.[0] ?? 0;
  data[41] = imprint.mouse?.[1] ?? 0;
  data[42] = metrics.originCell[0];
  data[43] = metrics.originCell[1];
  target.buffer.write(data);
}
