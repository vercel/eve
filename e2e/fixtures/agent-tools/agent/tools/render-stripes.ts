import { crc32, deflateSync } from "node:zlib";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

// Single-token names no model paraphrases (unlike cyan/teal or purple/violet),
// so the eval can match the reply against the rendered sequence verbatim.
const PALETTE = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  green: [0, 160, 0],
  orange: [255, 140, 0],
  red: [255, 0, 0],
  yellow: [255, 220, 0],
} as const;

type ColorName = keyof typeof PALETTE;

const WIDTH = 240;
const HEIGHT = 120;
const STRIPE_COUNT = 3;

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function renderStripesPng(stripes: readonly ColorName[]): Buffer {
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
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export default defineTool({
  description:
    "Smoke-test fixture: renders an image of colored vertical stripes chosen at random. " +
    "Only call when the user explicitly asks to use `render-stripes`. The colors appear " +
    "ONLY in the returned image — inspect it visually; do not guess.",
  inputSchema: z.object({}),
  async execute() {
    const names = Object.keys(PALETTE) as ColorName[];
    const colors = [...names].sort(() => Math.random() - 0.5).slice(0, STRIPE_COUNT);
    const png = renderStripesPng(colors);
    // `colors` is the eval's answer key. It reaches action.result (and the
    // eval's event stream) but never the model: the projection below sends
    // only the pixels.
    return { colors, imageBase64: png.toString("base64") };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text("Rendered stripes:"),
      toolOutputPart.file(output.imageBase64, {
        filename: "stripes.png",
        mediaType: "image/png",
      }),
    ]);
  },
});
