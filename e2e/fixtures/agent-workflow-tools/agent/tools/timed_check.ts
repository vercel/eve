import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

/**
 * Usually quick, sometimes long: a call still working after 8 seconds moves
 * to the background and reports its result later.
 */
export default defineWorkflowTool({
  description: "Run one check. Takes the given number of seconds.",
  inputSchema: z.strictObject({ label: z.string(), seconds: z.number().int().min(0).max(120) }),
  detach: { timeout: 8_000 },
  async execute({ label, seconds }) {
    "use workflow";

    if (seconds > 0) await sleep(`${seconds}s`);
    return { label, passed: true };
  },
});
