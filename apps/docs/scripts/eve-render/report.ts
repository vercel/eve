import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

// Owns PNG writing and pixel-stat helpers for offline Eve renders.
// INVARIANT: PNG bytes and pixelStats sha256 algorithm are unchanged.
// Imported only by views and render-eve-5.ts.

export async function writePng(path: string, width: number, height: number, pixels: Uint8Array) {
  const png = new PNG({ width, height });
  png.data.set(pixels);
  await writeFile(path, PNG.sync.write(png));
}

export function pixelStats(width: number, height: number, pixels: Uint8Array) {
  let nonBlack = 0;
  let alpha = 0;
  let colored = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const a = pixels[index + 3] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 8) nonBlack++;
    if (a > 20) alpha++;
    if (max - min > 8 && r + g + b > 24) colored++;
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  const sha256 = createHash("sha256").update(header).update(pixels).digest("hex");

  return { width, height, total: width * height, nonBlack, alpha, colored, sha256 };
}

export function maxFloat32(values: Float32Array) {
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  return max;
}
