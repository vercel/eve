import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { createHook, FatalError, getWorkflowMetadata, sleep } from "workflow";
import { z } from "zod";
import { publishVerificationGate } from "../../../lib/verification-gate.js";

async function execute({ key }: { key: string }, ctx: WorkflowToolContext) {
  "use workflow";
  const gate = createHook<string>({ metadata: { key, sessionId: ctx.session.id } });
  try {
    await publishVerificationGate(ctx.session.id, key, {
      token: gate.token,
      runId: getWorkflowMetadata().workflowRunId,
    });
    return await Promise.race([
      gate,
      sleep("2m").then(() => {
        throw new FatalError("Verification was not released within two minutes.");
      }),
    ]);
  } finally {
    await gate.dispose();
  }
}

const tool: WorkflowToolDefinition<{ key: string }, string> = defineWorkflowTool({
  description: "Wait for Alice to release the nested verification worker.",
  inputSchema: z.object({ key: z.string().uuid() }),
  execute,
});

export default tool;
