import { defineTool } from "eve/tools";
import { z } from "zod";
import { subagentHookAudit } from "../../subagent-hook-audit";

export default defineTool({
  description: "Read the parent session's durable subagent hook observations.",
  inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox();
    return await Promise.all(
      subagentHookAudit.get().map(async (record) => ({
        ...record,
        sandboxCallId: await sandbox.readTextFile({
          path: `subagent-hook-${record.eventId}-${record.subscriber}.txt`,
        }),
      })),
    );
  },
});
