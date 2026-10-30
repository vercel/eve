import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Read the review status of Alice's draft document without requiring approval. " +
    "Only call when the user explicitly asks to read the draft status.",
  inputSchema: z.object({ marker: z.string() }),
  async execute({ marker }) {
    return { marker, status: "ready" };
  },
});
