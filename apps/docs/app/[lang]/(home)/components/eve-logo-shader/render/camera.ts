// Camera framing, clip planes, and mesh-normalized coordinate helpers.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type { Bounds, MeshData, Vec3 } from "./types";
import { CAMERA_CLIP_PADDING, EVE_THICKNESS_SCALE_MULTIPLIER } from "./constants";
import { dot, sub } from "./math";

export function meshOrbitTarget(mesh: MeshData): Vec3 {
  return meshOrbitTargetFromBounds(mesh.bounds);
}

export function meshOrbitTargetFromBounds(bounds: Bounds): Vec3 {
  const height = bounds.max[1] - bounds.min[1] || 1;
  const depth = bounds.max[2] - bounds.min[2];
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

export function cameraClipPlanes(bounds: Bounds, eye: Vec3, forward: Vec3) {
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
  let near = Infinity;
  let far = -Infinity;
  for (const corner of corners) {
    const position = normalizePositionForGpu(corner, bounds);
    const depth = dot(sub(position, eye), forward);
    near = Math.min(near, depth);
    far = Math.max(far, depth);
  }
  return {
    near: Math.max(0.001, near - CAMERA_CLIP_PADDING),
    far: Math.max(0.002, far + CAMERA_CLIP_PADDING),
  };
}

export function cameraAxisDepthRange(bounds: Bounds, forward: Vec3) {
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

export function normalizePositionForGpu(position: Vec3, bounds: Bounds): Vec3 {
  const height = bounds.max[1] - bounds.min[1] || 1;
  const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
  const centerY = (bounds.min[1] + bounds.max[1]) * 0.5;
  const frontZ = bounds.max[2];
  return [
    (position[0] - centerX) / height,
    (position[1] - centerY) / height,
    (position[2] - frontZ) / height,
  ];
}
