// Epoch 98 of the tool capability: base64 file content parts still compile after file URLs were added.
import { defineTool, toolOutput, toolOutputPart } from "#public/tools/index.js";

export default defineTool({
  description: "Capture a screenshot.",
  inputSchema: {
    type: "object",
    properties: { page: { type: "string" } },
    required: ["page"],
    additionalProperties: false,
  },
  async execute(input: { page: string }) {
    return { page: input.page, png: "aGVsbG8=" };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`Screenshot of ${output.page}:`),
      toolOutputPart.file(output.png, { mediaType: "image/png", filename: "page.png" }),
      {
        type: "file",
        data: { type: "data", data: output.png },
        mediaType: "image/png",
      },
    ]);
  },
});
