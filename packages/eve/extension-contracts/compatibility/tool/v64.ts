import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 64 stream events had no `meta.index`. It is optional and only set on
// events read from a session stream, so compiled epoch 64 tools are unaffected.
export default defineTool({
  description: "Look up a ticket by id.",
  inputSchema: z.object({ ticketId: z.string() }),
  async execute({ ticketId }) {
    return { ticketId, status: "open" };
  },
});
