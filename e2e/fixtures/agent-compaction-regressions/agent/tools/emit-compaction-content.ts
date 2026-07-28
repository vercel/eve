import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import { CONTENT_OUTPUT_TAIL_MARKER } from "../../constants";

const INLINE_FILE_BASE64 = "A".repeat(12_000);

export default defineTool({
  description:
    "Compaction regression tool. Emits a large inline file followed by text that the checkpoint must preserve.",
  inputSchema: z.object({}),
  async execute() {
    return { completed: true };
  },
  toModelOutput() {
    return toolOutput.content([
      // The file stays first so prefix-clipping the serialized output loses the
      // trailing marker. Rendering an attachment stub leaves the marker visible.
      toolOutputPart.file(INLINE_FILE_BASE64, {
        filename: "compaction-evidence.bin",
        mediaType: "application/octet-stream",
      }),
      toolOutputPart.text(
        `Completed content-output work. Preserve this exact marker: ${CONTENT_OUTPUT_TAIL_MARKER}`,
      ),
    ]);
  },
});
