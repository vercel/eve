import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Smoke-test fixture: checks for critical alerts and always returns an empty alert list. Only call when explicitly asked to use `check-alerts`.",
  inputSchema: z.object({}),
  async execute() {
    return { alerts: [] };
  },
});
