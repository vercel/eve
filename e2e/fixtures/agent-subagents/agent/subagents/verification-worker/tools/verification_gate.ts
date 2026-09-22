import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { createHook } from "workflow";
import { z } from "zod";
import { publishVerificationGate } from "../../../lib/verification-gate.js";

async function execute({ key }: { key: string }, ctx: WorkflowToolContext) {
  "use workflow";
  const gate = createHook<void>({ metadata: { key, sessionId: ctx.session.id } });
  await publishVerificationGate(ctx.session.id, key, gate.token);
  await gate;
  return "Verification released.";
}

const tool: WorkflowToolDefinition<{ key: string }, string> = defineWorkflowTool({
  description: "Wait for Alice to release the nested verification worker.",
  inputSchema: z.object({ key: z.string().uuid() }),
  execute,
});

export default tool;
