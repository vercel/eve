import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Read the current draft status without requiring approval.",
  inputSchema: z.object({ marker: z.string() }),
  async execute({ marker }) {
    return { marker, status: "ready" };
  },
});
