import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

/** 1x1 red-pixel PNG. */
const RED_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

export default defineTool({
  description:
    "Smoke-test fixture: renders a single-pixel image the model must inspect visually. " +
    "Only call when the user explicitly asks to use `render-pixel`. The tool result " +
    "contains the image itself; do not guess the color from the JSON output.",
  inputSchema: z.object({
    label: z.string().describe("Any label string."),
  }),
  async execute(input) {
    return { label: input.label, pixelBase64: RED_PIXEL_BASE64 };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`Rendered pixel for "${output.label}":`),
      toolOutputPart.file(output.pixelBase64, {
        filename: "pixel.png",
        mediaType: "image/png",
      }),
    ]);
  },
});
