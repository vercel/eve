import { describe, expect, it } from "vitest";

import { estimateMediaTokens, readMediaMetadata } from "#internal/attachments/media-metadata.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";

function gifBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "latin1");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function jpegBytes(width: number, height: number): Buffer {
  // SOI, an APP0 segment the reader must skip, then SOF0 with the frame size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function webpBytes(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF", 0, "latin1");
  bytes.write("WEBP", 8, "latin1");
  bytes.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    bytes.writeUInt8(0x2f, 20);
    bytes.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

describe("readMediaMetadata", () => {
  it.each([
    ["PNG", pngBytes(640, 480), "image/png"],
    ["GIF", gifBytes(640, 480), "image/gif"],
    ["JPEG", jpegBytes(640, 480), "image/jpeg"],
    ["lossy WebP", webpBytes("VP8 ", 640, 480), "image/webp"],
    ["lossless WebP", webpBytes("VP8L", 640, 480), "image/webp"],
    ["extended WebP", webpBytes("VP8X", 640, 480), "image/webp"],
  ])("reads %s dimensions from the header", (_format, bytes, mediaType) => {
    expect(readMediaMetadata(bytes, mediaType)).toMatchObject({ height: 480, width: 640 });
  });

  it("counts PDF page objects without counting the page tree", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>",
      "latin1",
    );

    expect(readMediaMetadata(pdf, "application/pdf")).toMatchObject({ pages: 2 });
  });

  it("leaves dimensions out when the header is not a known image format", () => {
    expect(readMediaMetadata(Buffer.from("not an image"), "image/heic")).toEqual({
      mediaType: "image/heic",
      size: 12,
    });
  });
});

describe("estimateMediaTokens", () => {
  it("counts image patches up to the largest provider cap", () => {
    expect(
      estimateMediaTokens({ height: 1000, mediaType: "image/png", size: 1, width: 1000 }),
    ).toBe(1296);
    expect(
      estimateMediaTokens({ height: 3000, mediaType: "image/png", size: 1, width: 4000 }),
    ).toBe(4784);
    expect(estimateMediaTokens({ mediaType: "image/png", size: 1 })).toBe(4784);
  });

  it("counts PDFs per page and other files by their base64 size", () => {
    expect(estimateMediaTokens({ mediaType: "application/pdf", pages: 3, size: 9 })).toBe(9000);
    expect(estimateMediaTokens({ mediaType: "application/octet-stream", size: 9000 })).toBe(3000);
  });
});
