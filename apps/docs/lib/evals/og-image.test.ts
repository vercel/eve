import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { createEvalsOgImage } from "./og-image";

describe("createEvalsOgImage", () => {
  it("draws the eve wordmark in the top-left corner", async () => {
    const response = await createEvalsOgImage([]);
    const image = PNG.sync.read(Buffer.from(await response.arrayBuffer()));

    // The wordmark is white, 30px tall, and placed at (60, 60); nothing else
    // is drawn in that region.
    let whitePixels = 0;
    for (let y = 60; y < 90; y += 1) {
      for (let x = 60; x < 160; x += 1) {
        const offset = (y * image.width + x) * 4;
        if (
          image.data[offset]! > 200 &&
          image.data[offset + 1]! > 200 &&
          image.data[offset + 2]! > 200
        ) {
          whitePixels += 1;
        }
      }
    }

    expect(whitePixels).toBeGreaterThan(300);
  });
});
