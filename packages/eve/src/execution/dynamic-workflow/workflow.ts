import {
  parseDynamicWorkflowInput,
  readDynamicWorkflowCallInterrupt,
  type DynamicWorkflowInput,
} from "#execution/dynamic-workflow/schema.js";
import {
  runDynamicWorkflowProgramStep,
  type DynamicWorkflowProgramOutcome,
} from "#execution/dynamic-workflow/program-step.js";
import { invokeAgent } from "#execution/tools/subagent/invoke-agent.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { ToolContext } from "#tools/definition.js";

/** Durable subagent-only JavaScript orchestration body behind `workflow`. */
export async function dynamicWorkflow(rawInput: unknown, ctx: ToolContext): Promise<JsonValue> {
  "use workflow";

  const program = parseDynamicWorkflowInput(rawInput);
  const base = { callId: ctx.callId, program };
  let outcome: DynamicWorkflowProgramOutcome = await runDynamicWorkflowProgramStep(base);
  let calls = 0;
  while (outcome.status === "interrupted") {
    ctx.abortSignal.throwIfAborted();
    const resolutions = await Promise.all(
      outcome.pending.map(async (pending) => {
        const call = readDynamicWorkflowCallInterrupt(pending);
        const invocationIndex = calls++;
        if (invocationIndex >= program.maxSubagents) {
          return {
            status: "failed" as const,
            error: `WORKFLOW_SUBAGENT_LIMIT_REACHED: workflow may invoke at most ${String(program.maxSubagents)} subagents per program; "${call.toolName}" was not called.`,
          };
        }
        try {
          const input = readAgentInput(call.toolInput);
          const output = await invokeAgent(
            ctx,
            { ...input, target: call.toolName },
            { invocationId: `${ctx.callId}:${String(invocationIndex)}` },
          );
          return { status: "completed" as const, output };
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          return { status: "failed" as const, error: toErrorMessage(error) };
        }
      }),
    );
    outcome = await runDynamicWorkflowProgramStep({
      ...base,
      resume: { interrupt: outcome.interrupt, resolutions },
    });
  }
  return outcome.output;
}

interface DynamicWorkflowAgentInput {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

export function readAgentInput(value: unknown): DynamicWorkflowAgentInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Subagent calls from workflow require an object input.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string") {
    throw new TypeError('Subagent calls from workflow require a "message" string.');
  }
  const input: {
    -readonly [K in keyof DynamicWorkflowAgentInput]: DynamicWorkflowAgentInput[K];
  } = { message: record.message };
  if (typeof record.agentId === "string") input.agentId = record.agentId;
  if (typeof record.outputSchema === "object" && record.outputSchema !== null) {
    input.outputSchema = record.outputSchema as JsonObject;
  }
  return input;
}

export type { DynamicWorkflowInput };
