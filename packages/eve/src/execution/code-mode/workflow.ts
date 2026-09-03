import type { ToolContext } from "#tools/definition.js";
import { invokeAgent } from "#execution/tools/subagent/invoke-agent.js";
import { readCodeModeRunContext } from "#execution/tools/workflow/ask.js";
import { parseCodeModeWorkflowInput } from "#execution/code-mode/schema.js";
import {
  executeCodeModeToolStep,
  runCodeModeProgramStep,
  type CodeModeProgramOutcome,
} from "#execution/code-mode/program-step.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/**
 * Durable body behind the framework `code_mode` tool.
 *
 * The generated program runs in a sandbox that parks at every nested call.
 * Ordinary tools execute in a child-owned step over the turn's serialized
 * context; subagents go through the owner's `agent-invoke` channel like any
 * workflow tool, so the parent keeps sole ownership of agent handles and
 * session state. Each nested call therefore has its own replay boundary.
 */
export async function codeModeWorkflow(rawInput: unknown, ctx: ToolContext): Promise<JsonValue> {
  "use workflow";

  const program = parseCodeModeWorkflowInput(rawInput);
  const run = readCodeModeRunContext(ctx);
  let outcome: CodeModeProgramOutcome = await runCodeModeProgramStep({
    callId: ctx.callId,
    program,
    serializedContext: run.serializedContext,
    sessionState: run.sessionState,
  });
  let nested = 0;
  while (outcome.status === "interrupted") {
    if (ctx.abortSignal.aborted) {
      throw ctx.abortSignal.reason ?? new Error("code_mode was cancelled.");
    }
    const { call, interrupt, toolCallId } = outcome;
    const invocationId = `${ctx.callId}:${String(nested++)}`;
    let resolution: unknown;
    if (call.target === "agent") {
      const agentInput = readAgentInput(call.toolInput);
      resolution = await invokeAgent(
        ctx,
        { ...agentInput, target: call.toolName },
        { invocationId },
      );
    } else {
      const result = await executeCodeModeToolStep({
        callId: ctx.callId,
        serializedContext: run.serializedContext,
        sessionState: run.sessionState,
        toolCallId,
        toolInput: call.toolInput,
        toolName: call.toolName,
      });
      resolution = result.isError ? { error: result.output } : result.output;
    }
    outcome = await runCodeModeProgramStep({
      callId: ctx.callId,
      program,
      resume: { interrupt, resolution },
      serializedContext: run.serializedContext,
      sessionState: run.sessionState,
    });
  }
  return outcome.output;
}

interface CodeModeAgentInput {
  agentId?: string;
  message: string;
  outputSchema?: JsonObject;
}

function readAgentInput(value: unknown): CodeModeAgentInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Subagent calls from code_mode require an object input.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string") {
    throw new TypeError('Subagent calls from code_mode require a "message" string.');
  }
  const input: CodeModeAgentInput = { message: record.message };
  if (typeof record.agentId === "string") input.agentId = record.agentId;
  if (typeof record.outputSchema === "object" && record.outputSchema !== null) {
    input.outputSchema = record.outputSchema as JsonObject;
  }
  return input;
}
