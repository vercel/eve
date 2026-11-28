import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { eveBenchmark, orderedModels } from "./eve-results";
import { createBenchmarksOgImage, createEvalsOgImage } from "./og-image";

function countWhitePixelsInLogoRegion(buffer: Buffer): number {
  const image = PNG.sync.read(buffer);
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
  return whitePixels;
}

describe("benchmark OG images", () => {
  it("draws the eve wordmark in the authoring OG image", async () => {
    const response = await createEvalsOgImage([]);
    expect(countWhitePixelsInLogoRegion(Buffer.from(await response.arrayBuffer()))).toBeGreaterThan(
      300,
    );
  });

  it("renders the multi-model harness OG image with the eve wordmark", async () => {
    const dataset = eveBenchmark.datasets["deepswe-lean"];
    const response = await createBenchmarksOgImage(dataset ? orderedModels(dataset) : []);
    expect(countWhitePixelsInLogoRegion(Buffer.from(await response.arrayBuffer()))).toBeGreaterThan(
      300,
    );
  });
});
