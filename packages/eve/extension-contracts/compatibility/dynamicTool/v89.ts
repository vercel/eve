import { defineDynamic, defineTool, toolOutput, toolOutputPart } from "#public/tools/index.js";

// Epoch 89 file content parts carried base64 data only; epoch 90 adds file URLs, which is additive.
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineTool({
        description: "Capture a screenshot.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ png: "aGVsbG8=" }),
        toModelOutput: (output) =>
          toolOutput.content([toolOutputPart.file(output.png, { mediaType: "image/png" })]),
      }),
  },
});
