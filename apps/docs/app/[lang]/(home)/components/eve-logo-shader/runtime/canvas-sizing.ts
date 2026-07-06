import { DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO, bloomRadiusForDevicePixelRatio } from "../render";

// Owns canvas and hero-logo sizing math for the browser renderer.
// INVARIANT: load-bearing DPR/back-target alignment; must match getPaddedRenderSize.
// Imported by index.tsx and runtime frame orchestration only.

export const DEFAULT_LOGO_ASPECT = 78 / 25;
const LOGO_RENDER_HEIGHT = 500;
const MAX_DEVICE_PIXEL_RATIO = DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO;

export function getLogicalRenderSize(aspect: number) {
  return {
    width: Math.max(1, Math.round(LOGO_RENDER_HEIGHT * aspect)),
    height: LOGO_RENDER_HEIGHT,
  };
}

export function getBrowserDevicePixelRatio() {
  return Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
}

export function resizeCanvas(canvas: HTMLCanvasElement | null) {
  const dpr = getBrowserDevicePixelRatio();
  if (!canvas) return dpr;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return dpr;
}

export function getCanvasLogicalSize(
  canvas: HTMLCanvasElement,
  devicePixelRatio = getBrowserDevicePixelRatio(),
) {
  // The renderer pads the logical scene size by a DPR-scaled bloom radius on each side before
  // allocating its offscreen back/depth targets. The canvas itself is that padded physical render
  // target, so subtract the same physical padding here. Passing CSS/logical logo dimensions would
  // make the front shader's @builtin(position) sample different pixels from the back-side targets.
  const bloomRadius = bloomRadiusForDevicePixelRatio(devicePixelRatio);
  return {
    logicalWidth: Math.max(1, canvas.width - bloomRadius * 2),
    logicalHeight: Math.max(1, canvas.height - bloomRadius * 2),
  };
}
