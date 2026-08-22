import { defineTool } from "eve/tools";
import { z } from "zod";

const HOLD_OPEN_MS = 4_000;

export default defineTool({
  description:
    "Test-only tool that keeps a model turn active long enough to deliver concurrent follow-up messages. Call it exactly once only when the user explicitly requests `hold-open`.",
  inputSchema: z.object({
    marker: z.string(),
  }),
  async execute({ marker }) {
    await new Promise((resolve) => setTimeout(resolve, HOLD_OPEN_MS));
    return { marker };
  },
});
