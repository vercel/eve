import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

/** 64x64 solid-red PNG (132 bytes), small enough to inline but large enough for every provider. */
const RED_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC";

export default defineTool({
  description:
    "Smoke-test fixture: renders a small solid-color image the model must inspect visually. " +
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
