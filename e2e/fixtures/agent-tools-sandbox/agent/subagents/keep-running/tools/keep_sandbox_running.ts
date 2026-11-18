import { defineTool } from "eve/tools";
import { z } from "zod";

// Exits 0 while the job wrote to its log in the last minute.
const JOB_WRITES_ITS_LOG = "find /workspace/keep-running.log -mmin -1 | grep -q .";

export default defineTool({
  description:
    "Keeps the sandbox running for up to 5 minutes while the job keeps writing to /workspace/keep-running.log.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    const { until } = await sandbox.keepRunning({ forMs: 5 * 60_000, while: JOB_WRITES_ITS_LOG });
    return { kept: until !== null };
  },
});
