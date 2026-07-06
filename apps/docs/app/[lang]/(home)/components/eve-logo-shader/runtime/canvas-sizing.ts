import { BLOOM_RADIUS } from "../render";

// Owns canvas and hero-logo sizing math for the browser renderer.
// INVARIANT: load-bearing DPR/back-target alignment; must match getPaddedRenderSize.
// Imported by index.tsx and runtime frame orchestration only.

export const DEFAULT_LOGO_ASPECT = 78 / 25;
const LOGO_RENDER_HEIGHT = 500;
const MAX_DEVICE_PIXEL_RATIO = 2;

export function getLogicalRenderSize(aspect: number) {
  return {
    width: Math.max(1, Math.round(LOGO_RENDER_HEIGHT * aspect)),
    height: LOGO_RENDER_HEIGHT,
  };
}

export function resizeCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

export function getCanvasLogicalSize(canvas: HTMLCanvasElement) {
  // The renderer pads the logical scene size by BLOOM_RADIUS on each side before allocating
  // its offscreen back/depth targets. The canvas itself is that padded physical render target,
  // so subtract the padding here. Passing CSS/logical logo dimensions would make the front
  // shader's @builtin(position) sample different pixels from the back-side targets on DPR > 1.
  return {
    logicalWidth: Math.max(1, canvas.width - BLOOM_RADIUS * 2),
    logicalHeight: Math.max(1, canvas.height - BLOOM_RADIUS * 2),
  };
}
