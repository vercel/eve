import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { getIntegration } from "./data";
import { createIntegrationOgImage } from "./og-image";

const renderIntegrationOgImage = async (slug: string): Promise<PNG> => {
  const image = await createIntegrationOgImage(getIntegration(slug)!);
  return PNG.sync.read(Buffer.from(await image.arrayBuffer()));
};

const countPixels = (
  image: PNG,
  matches: (red: number, green: number, blue: number) => boolean,
) => {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (
      image.data[offset + 3]! > 0 &&
      matches(image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!)
    ) {
      count += 1;
    }
  }
  return count;
};

describe("createIntegrationOgImage", () => {
  it("preserves multicolor integration logos", async () => {
    const image = await renderIntegrationOgImage("slack");
    const saturatedPixels = countPixels(
      image,
      (red, green, blue) => Math.max(red, green, blue) - Math.min(red, green, blue) > 50,
    );

    expect(saturatedPixels).toBeGreaterThan(100);
  });

  it("gives dark logos a light backing against the black background", async () => {
    const image = await renderIntegrationOgImage("arcana");
    const lightBackingPixels = countPixels(
      image,
      (red, green, blue) => red === 244 && green === 244 && blue === 245,
    );
    const darkLogoPixels = countPixels(
      image,
      (red, green, blue) => red === 26 && green === 28 && blue === 26,
    );

    expect(lightBackingPixels).toBeGreaterThan(10_000);
    expect(darkLogoPixels).toBeGreaterThan(100);
  });
});
