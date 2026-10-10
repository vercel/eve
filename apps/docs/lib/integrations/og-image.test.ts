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

  it("lifts dark logo colors enough to read against the black background", async () => {
    const image = await renderIntegrationOgImage("arcana");
    const liftedLogoPixels = countPixels(
      image,
      (red, green, blue) =>
        red >= 150 && red <= 210 && green >= 150 && green <= 210 && blue >= 150 && blue <= 210,
    );
    const blackBackgroundPixels = countPixels(
      image,
      (red, green, blue) => red === 0 && green === 0 && blue === 0,
    );

    expect(liftedLogoPixels).toBeGreaterThan(100);
    expect(blackBackgroundPixels).toBeGreaterThan(100_000);
  });
});
