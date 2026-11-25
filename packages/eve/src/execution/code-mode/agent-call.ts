import type { JsonObject, JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface ProgramAgentCallInput {
  readonly target: string;
  readonly message: string;
  readonly model?: string;
  readonly outputSchema?: JsonObject;
}

export async function programAgentCallWorkflow(
  input: ProgramAgentCallInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return await callProgramAgent(input, ctx);
}

export async function callProgramAgent(
  input: ProgramAgentCallInput,
  ctx: WorkflowToolContext,
  name: string = ctx.toolName,
): Promise<JsonValue> {
  const { message, model, outputSchema, target } = input;
  const agent = ctx.agent(target, model === undefined ? undefined : { model });
  const response = await agent.send<JsonValue>(message, { outputSchema, signal: ctx.abortSignal });
  const result = await response.result();
  ctx.abortSignal.throwIfAborted();
  if (result.status === "failed") {
    throw new Error(`Agent "${name}" failed to handle the message: ${result.error.message}`);
  }
  if (result.status === "cancelled") {
    throw new Error(`Agent "${name}" was cancelled before completing.`);
  }
  return outputSchema !== undefined ? (result.data ?? null) : (result.reply ?? null);
}
