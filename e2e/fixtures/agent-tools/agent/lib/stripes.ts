import { crc32, deflateSync, inflateSync } from "node:zlib";

// Single-token names no model paraphrases (unlike cyan/teal or purple/violet),
// so the eval can match the reply against the rendered sequence verbatim.
export const PALETTE = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  green: [0, 160, 0],
  orange: [255, 140, 0],
  red: [255, 0, 0],
  yellow: [255, 220, 0],
} as const;

export type ColorName = keyof typeof PALETTE;

export const STRIPE_COUNT = 3;

const WIDTH = 240;
const HEIGHT = 120;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Renders equal-width vertical stripes as an 8-bit truecolor PNG. */
export function renderStripesPng(stripes: readonly ColorName[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor

  const stripeWidth = WIDTH / stripes.length;
  const row = Buffer.alloc(1 + WIDTH * 3); // leading scanline filter byte 0
  for (let x = 0; x < WIDTH; x += 1) {
    const stripe = Math.min(Math.floor(x / stripeWidth), stripes.length - 1);
    const color = PALETTE[stripes[stripe]!];
    row.set(color, 1 + x * 3);
  }
  const idat = deflateSync(Buffer.concat(Array.from({ length: HEIGHT }, () => row)), { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Reads the stripe colors back out of a {@link renderStripesPng} image, so a
 * scripted model can answer only when the pixels actually reached it.
 */
export function readStripeColors(png: Buffer, stripeCount: number): ColorName[] | undefined {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const width = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const firstRow = inflateSync(Buffer.concat(idat)).subarray(1, 1 + width * 3);
  const colors: ColorName[] = [];
  for (let stripe = 0; stripe < stripeCount; stripe += 1) {
    const x = Math.floor((width / stripeCount) * (stripe + 0.5));
    const pixel = [...firstRow.subarray(x * 3, x * 3 + 3)];
    const name = (Object.keys(PALETTE) as ColorName[]).find((candidate) =>
      PALETTE[candidate].every((channel, index) => channel === pixel[index]),
    );
    if (name === undefined) return undefined;
    colors.push(name);
  }
  return colors;
}
