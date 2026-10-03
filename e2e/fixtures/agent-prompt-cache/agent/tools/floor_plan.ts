import { crc32, deflateSync } from "node:zlib";
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

const WIDTH = 768;
const HEIGHT = 512;
const STAGE_HEIGHT = 96;
const WHITE = [255, 255, 255] as const;
const BLUE = [0, 0, 255] as const;
const ORANGE = [255, 140, 0] as const;

// The stage is a blue band along the top; eight orange tables sit in a
// four-by-two grid below it. Large enough for providers to bill hundreds of
// image tokens, so the image is a real share of the cached prefix.
function pixel(x: number, y: number): readonly [number, number, number] {
  if (y < STAGE_HEIGHT) return BLUE;
  const cellX = x % (WIDTH / 4);
  const cellY = (y - STAGE_HEIGHT) % ((HEIGHT - STAGE_HEIGHT) / 2);
  return cellX >= 48 && cellX < 144 && cellY >= 64 && cellY < 144 ? ORANGE : WHITE;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function renderFloorPlanPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const rows = Array.from({ length: HEIGHT }, (_, y) => {
    const row = Buffer.alloc(1 + WIDTH * 3); // leading scanline filter byte 0
    for (let x = 0; x < WIDTH; x += 1) row.set(pixel(x, y), 1 + x * 3);
    return row;
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export default defineTool({
  description:
    "Show the main hall floor plan as an image. Only call when the user explicitly asks " +
    "to use `floor_plan`. The layout appears ONLY in the image; inspect it visually.",
  inputSchema: z.object({}),
  async execute() {
    return { room: "main hall" };
  },
  toModelOutput() {
    return toolOutput.content([
      toolOutputPart.text("Main hall floor plan:"),
      toolOutputPart.file(renderFloorPlanPng().toString("base64"), {
        filename: "main-hall-floor-plan.png",
        mediaType: "image/png",
      }),
    ]);
  },
});
