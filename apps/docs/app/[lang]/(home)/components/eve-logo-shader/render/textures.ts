// Render target sizing, texture factories, and static noise upload.
// INVARIANT: Pure move from render.ts; keep shader ABI, binding order, and pixel output unchanged.
// Imported by render/renderer.ts and re-exported only through render.ts facade.

import { Device } from "@vgpu/core";
import {
  BACK_DEPTH_FORMAT,
  BLOOM_RADIUS,
  PAINT_FORMAT,
  PAINT_STATIC_NOISE_FORMAT,
  SCENE_FORMAT,
  VORONOI_NOISE_FORMAT,
} from "./constants";

export function getPaddedRenderSize(width: number, height: number, paddingRadius = BLOOM_RADIUS) {
  const padding = Math.max(0, Math.round(paddingRadius)) * 2;
  return {
    width: Math.max(1, Math.round(width)) + padding,
    height: Math.max(1, Math.round(height)) + padding,
  };
}

export function createBloomTexture(device: Device, label: string, width: number, height: number) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: SCENE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export function createBackDepthTexture(
  device: Device,
  label: string,
  width: number,
  height: number,
) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: BACK_DEPTH_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

export function createPaintTexture(device: Device, label: string, width: number, height: number) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: PAINT_FORMAT,
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
}

export function createPaintStaticNoiseTexture(
  device: Device,
  label: string,
  width: number,
  height: number,
) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: PAINT_STATIC_NOISE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

export function createVoronoiNoiseTexture(
  device: Device,
  label: string,
  width: number,
  height: number,
) {
  return device.gpu.createTexture({
    label,
    size: [width, height],
    format: VORONOI_NOISE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
}

export function uploadStaticNoiseTexture(
  device: Device,
  texture: GPUTexture,
  width: number,
  height: number,
) {
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      values[offset] = hashPaintCell(x, y, 0xa511e9b3);
      values[offset + 1] = hashPaintCell(x, y, 0x63d83595);
      values[offset + 2] = hashPaintCell(x, y, 0xf9bd1c5b);
      values[offset + 3] = hashPaintCell(x, y, 0x1c4b256d);
    }
  }
  device.gpu.queue.writeTexture(
    { texture },
    values,
    { bytesPerRow: width * 4 * Float32Array.BYTES_PER_ELEMENT, rowsPerImage: height },
    { width, height },
  );
}

export function hashPaintCell(x: number, y: number, salt: number) {
  let h = (Math.imul(x >>> 0, 0x8da6b343) ^ Math.imul(y >>> 0, 0xd8163841) ^ salt) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0x00ffffff) / 0x01000000;
}
