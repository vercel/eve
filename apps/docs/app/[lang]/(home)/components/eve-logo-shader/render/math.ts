// Small matrix/vector math helpers used by camera and params.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import type { Mat4, Vec3 } from "./types";
import { BASELINE_CAMERA_FOV, BASELINE_CAMERA_RADIUS } from "./constants";

export function orbitEye(
  target: Vec3,
  radius: number,
  yawRadians: number,
  pitchRadians: number,
): Vec3 {
  const cp = Math.cos(pitchRadians);
  return [
    target[0] + radius * cp * Math.sin(yawRadians),
    target[1] + radius * Math.sin(pitchRadians),
    target[2] + radius * cp * Math.cos(yawRadians),
  ];
}

export function cameraBasis(eye: Vec3, target: Vec3) {
  const forward = normalize(sub(target, eye));
  const upRef: Vec3 = Math.abs(dot(forward, [0, 1, 0])) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, upRef));
  const up = cross(right, forward);
  return { forward, right, up };
}

export function perspective(fovYRadians: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (far * near) / (near - far);
  return m;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
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

export function multiply(a: Mat4, b: Mat4): Mat4 {
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

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function mix(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function cameraRadiusForFov(
  fovDegrees: number,
  baselineRadius = BASELINE_CAMERA_RADIUS,
  baselineFovDegrees = BASELINE_CAMERA_FOV,
) {
  const baselineHalfFov = degreesToRadians(baselineFovDegrees) * 0.5;
  const targetHalfFov = degreesToRadians(fovDegrees) * 0.5;
  return (baselineRadius * Math.tan(baselineHalfFov)) / Math.tan(targetHalfFov);
}

export function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}
