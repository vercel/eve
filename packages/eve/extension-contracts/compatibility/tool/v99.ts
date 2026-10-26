// Retained tool epoch 99: file outputs still compile with proactive session preparation.
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
      toolOutputPart.fileUrl("https://reports.example.com/page.png", { mediaType: "image/png" }),
      {
        type: "file",
        data: { type: "data", data: output.png },
        mediaType: "image/png",
      },
    ]);
  },
});
