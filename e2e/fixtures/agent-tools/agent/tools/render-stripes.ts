import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { type ColorName, PALETTE, renderStripesPng, STRIPE_COUNT } from "../lib/stripes";

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
