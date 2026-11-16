import type { JsonObject, JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

/** One `tools.<agent>(input)` call of a program, as its run starts. */
export interface ProgramAgentCallInput {
  /** The agent `ctx.agent` opens: the tool's name, or `agent` for a copy of the root. */
  readonly target: string;
  readonly message: string;
  /** The model key an `agent({ models })` call chose. */
  readonly model?: string;
  readonly outputSchema?: JsonObject;
}

/**
 * Runs one agent call a program made, in place of the agent tool's own `serve` body: a program
 * awaits the agent's reply instead of starting a task. Each call opens a new session, which the
 * run owns and ends, so the model's task table never holds it.
 */
export async function programAgentCallWorkflow(
  input: ProgramAgentCallInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return await callProgramAgent(input, ctx);
}

/** {@link programAgentCallWorkflow}'s body, for a host that runs it without Workflow. */
export async function callProgramAgent(
  input: ProgramAgentCallInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  const { message, model, outputSchema, target } = input;
  const agent = ctx.agent(target, model === undefined ? undefined : { model });
  const response = await agent.send<JsonValue>(message, { outputSchema, signal: ctx.abortSignal });
  const result = await response.result();
  if (result.status === "failed") {
    throw new Error(
      `Agent "${ctx.toolName}" failed to handle the message: ${result.error.message}`,
    );
  }
  return outputSchema !== undefined ? (result.data ?? null) : (result.reply ?? null);
}
