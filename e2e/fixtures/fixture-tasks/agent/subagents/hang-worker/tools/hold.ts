import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Test-only subagent hold.",
  inputSchema: z.object({ durationMs: z.literal(45_000) }),
  async execute({ durationMs }) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return { held: `${durationMs}ms` };
  },
});
