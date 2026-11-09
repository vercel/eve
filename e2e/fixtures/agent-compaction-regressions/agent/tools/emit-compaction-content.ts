import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";

import {
  CONTENT_OUTPUT_FILENAME,
  CONTENT_OUTPUT_LEAD_MARKER,
  CONTENT_OUTPUT_PAYLOAD_CANARY,
  CONTENT_OUTPUT_TAIL_MARKER,
} from "../../constants";

// A PNG signature and 2000x2000 IHDR chunk (33 bytes, so 44 base64 characters
// with no padding) make eve verify the file as an image it inlines, so the
// payload reaches the model and weighs on history like any screenshot. The
// canary sits within the first 2000 serialized characters, where the old
// prefix-clipping rendering would expose it to the compaction model, and on a
// base64 group boundary so it survives eve's decode and re-encode unchanged.
// The rest of the payload pushes the trailing text far past that clip budget.
const PNG_HEADER = Buffer.from(
  "89504e470d0a1a0a" + "0000000d49484452" + "000007d0000007d00806000000" + "00000000",
  "hex",
);
const INLINE_FILE_BASE64 =
  `${PNG_HEADER.toString("base64")}${"A".repeat(400)}` +
  `${CONTENT_OUTPUT_PAYLOAD_CANARY}${"A".repeat(11_599)}`;

export default defineTool({
  description:
    "Collect Alice's review note, its attachment, and the closing note for Bob's reading-list handoff.",
  inputSchema: z.object({}),
  async execute() {
    return { completed: true };
  },
  toModelOutput() {
    return toolOutput.content([
      // The lead marker is spelled ONLY here — never in the tail's preserve
      // instructions — so it can reach the checkpoint solely through this
      // part's own rendering.
      toolOutputPart.text(`Alice's completed review note: ${CONTENT_OUTPUT_LEAD_MARKER}`),
      toolOutputPart.file(INLINE_FILE_BASE64, {
        filename: CONTENT_OUTPUT_FILENAME,
        mediaType: "image/png",
      }),
      // "The attachment's filename" is deliberately not spelled out: the
      // checkpoint can only carry it by reading the rendered stub.
      toolOutputPart.text(
        "Bob's handoff uses the note references labelled CONTENT_OUTPUT_TEXT_* " +
          "and the attachment's filename. " +
          `The closing note reference is ${CONTENT_OUTPUT_TAIL_MARKER}`,
      ),
    ]);
  },
});
