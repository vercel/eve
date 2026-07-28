import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import {
  CONTENT_OUTPUT_FILENAME,
  CONTENT_OUTPUT_LEAD_MARKER,
  CONTENT_OUTPUT_PAYLOAD_CANARY,
  CONTENT_OUTPUT_TAIL_MARKER,
} from "../../constants";

// The canary sits within the first 2000 serialized characters, where the old
// prefix-clipping rendering would expose it to the compaction model. The rest
// of the payload pushes the trailing text far past that clip budget.
const INLINE_FILE_BASE64 = `${"A".repeat(400)}${CONTENT_OUTPUT_PAYLOAD_CANARY}${"A".repeat(11_600)}`;

export default defineTool({
  description:
    "Compaction regression tool. Emits text, a large inline file, and trailing text the " +
    "checkpoint must preserve.",
  inputSchema: z.object({}),
  async execute() {
    return { completed: true };
  },
  toModelOutput() {
    return toolOutput.content([
      // The lead marker is spelled ONLY here — never in the tail's preserve
      // instructions — so it can reach the checkpoint solely through this
      // part's own rendering.
      toolOutputPart.text(`Work log (preserve this marker): ${CONTENT_OUTPUT_LEAD_MARKER}`),
      toolOutputPart.file(INLINE_FILE_BASE64, {
        filename: CONTENT_OUTPUT_FILENAME,
        mediaType: "application/octet-stream",
      }),
      // "The attachment's filename" is deliberately not spelled out: the
      // checkpoint can only carry it by reading the rendered stub.
      toolOutputPart.text(
        "Completed content-output work. Preserve every CONTENT_OUTPUT_TEXT_* marker visible " +
          "in this conversation and the attachment's exact filename. " +
          `Preserve this exact marker: ${CONTENT_OUTPUT_TAIL_MARKER}`,
      ),
    ]);
  },
});
