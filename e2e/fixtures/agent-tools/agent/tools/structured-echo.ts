import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Smoke-test fixture: echoes the input as structured output. Only call when the user explicitly asks to use `structured-echo`.",
  inputSchema: z.object({
    label: z.string().describe("Any label string."),
  }),
  async execute(input) {
    return {
      echoed: input.label,
      timestamp: 1700000000,
      nested: { ok: true },
    };
  },
});
