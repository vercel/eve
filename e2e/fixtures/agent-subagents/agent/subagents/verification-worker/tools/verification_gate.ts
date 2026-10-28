import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { createHook, FatalError, sleep } from "eve/workflow";
import { z } from "zod";
import { verificationToken } from "../../../lib/verification-gate.js";

async function execute({ key }: { key: string }, ctx: WorkflowToolContext) {
  "use workflow";
  using gate = createHook<string>({ token: verificationToken(ctx.session.id, key) });
  return await Promise.race([
    gate,
    sleep("2m").then(() => {
      throw new FatalError("Verification was not released within two minutes.");
    }),
  ]);
}

const tool: WorkflowToolDefinition<{ key: string }, string> = defineWorkflowTool({
  description: "Wait for Alice's release checklist sign-off and return its sign-off code.",
  inputSchema: z.object({ key: z.string().uuid() }),
  execute,
});

export default tool;
