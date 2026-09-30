import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { getIntegration } from "./data";
import { createIntegrationOgImage } from "./og-image";

describe("createIntegrationOgImage", () => {
  it("preserves multicolor integration logos", async () => {
    const image = await createIntegrationOgImage(getIntegration("slack")!);
    const png = PNG.sync.read(Buffer.from(await image.arrayBuffer()));
    let hasBrandColor = false;

    for (let offset = 0; offset < png.data.length; offset += 4) {
      const red = png.data[offset]!;
      const green = png.data[offset + 1]!;
      const blue = png.data[offset + 2]!;
      const alpha = png.data[offset + 3]!;
      if (alpha > 0 && Math.max(red, green, blue) - Math.min(red, green, blue) > 50) {
        hasBrandColor = true;
        break;
      }
    }

    expect(hasBrandColor).toBe(true);
  });
});
