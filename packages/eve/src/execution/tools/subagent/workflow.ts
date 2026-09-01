import { invokeAgent } from "eve/workflow";
import type { ToolContext } from "eve/tools";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface SubagentWorkflowInput {
  readonly agentId?: string | null;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

/**
 * The one userspace-style execute body used by every local and remote
 * subagent tool. The owning task dispatches the child after it is acknowledged.
 */
export async function subagentToolExecuteWorkflow(
  input: SubagentWorkflowInput,
  ctx: ToolContext,
): Promise<unknown> {
  "use workflow";
  const invocation = {
    ...(typeof input.agentId === "string" && input.agentId.trim() !== ""
      ? { agentId: input.agentId }
      : {}),
    message: input.message,
    outputSchema: input.outputSchema,
    target: ctx.toolName,
  };
  return await invokeAgent(ctx, invocation, { invocationId: ctx.callId });
}
