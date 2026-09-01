import { invokeAgent } from "eve/workflow";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SubagentWorkflowInput {
  readonly agentId?: string | null;
  readonly message: string;
  readonly outputSchema?: Record<string, unknown>;
}

/** Shared execute body for local, remote, dynamic, and self-agent tools. */
export async function subagentToolExecuteWorkflow(
  input: SubagentWorkflowInput,
  ctx: Parameters<typeof invokeAgent>[0],
): Promise<unknown> {
  "use workflow";
  const invocation = {
    ...(typeof input.agentId === "string" && input.agentId.trim() !== ""
      ? { agentId: input.agentId }
      : {}),
    message: input.message,
    outputSchema: input.outputSchema as JsonObject | undefined,
    target: ctx.toolName,
  };
  return await invokeAgent(ctx, invocation, { invocationId: ctx.callId });
}
