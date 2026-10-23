import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES,
  parseWorkflowProgramOptions,
  type WorkflowProgramAgentCall,
  type WorkflowProgramInput,
  type WorkflowProgramResolution,
} from "#execution/dynamic-workflow/schema.js";
import {
  runWorkflowProgramStep,
  type WorkflowProgramStepOutcome,
} from "#execution/dynamic-workflow/program-step.js";
import { createWorkflowProgramContinuationSecurityStep } from "#execution/dynamic-workflow/security-step.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface JsProgramOptions {
  /** Maximum child-agent calls, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

/** Runs a model-generated JavaScript function body inside an isolated workflow sandbox. */
export async function runJsProgram(
  js: string,
  ctx: WorkflowToolContext,
  options: JsProgramOptions,
): Promise<JsonValue> {
  if (typeof js !== "string") throw new TypeError('workflow requires a "js" string.');
  const optionsWithDefaults = parseWorkflowProgramOptions({
    maxSubagents: options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  });
  const program: WorkflowProgramInput = {
    ...optionsWithDefaults,
    continuationSecurity: await createWorkflowProgramContinuationSecurityStep(),
    js,
  };
  const base = { callId: ctx.callId, program };
  let outcome: WorkflowProgramStepOutcome = await runWorkflowProgramStep(base);
  let calls = 0;
  while (outcome.status === "interrupted") {
    ctx.abortSignal.throwIfAborted();
    const resolutions = await Promise.all(
      outcome.pending.map(async ({ call, id }): Promise<WorkflowProgramResolution> => {
        const invocationIndex = calls++;
        if (invocationIndex >= program.maxSubagents) {
          return {
            interruptionId: id,
            value: {
              status: "failed",
              error: `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most ${String(program.maxSubagents)} agents; "${call.target}" was not called.`,
            },
          };
        }
        try {
          const output = await callProgramAgent(ctx, call);
          return { interruptionId: id, value: { status: "completed", output } };
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          return { interruptionId: id, value: { status: "failed", error: toErrorMessage(error) } };
        }
      }),
    );
    outcome = await runWorkflowProgramStep({
      ...base,
      resume: { continuation: outcome.continuation, resolutions },
    });
  }
  return outcome.output;
}

/** Sends one program agent call to a new session and returns that turn's reply. */
async function callProgramAgent(
  ctx: WorkflowToolContext,
  call: WorkflowProgramAgentCall,
): Promise<JsonValue> {
  const { message, outputSchema } = call.input;
  const response = await ctx
    .agent(call.target)
    .send<JsonValue>(message, { outputSchema, signal: ctx.abortSignal });
  const result = await response.result();
  if (result.status === "failed") {
    throw new Error(
      `Agent "${call.target}" failed to handle the message: ${result.error?.message ?? "no reason given"}`,
    );
  }
  const output = outputSchema !== undefined ? (result.data ?? null) : (result.message ?? null);
  // Checked here so the program can catch an oversized reply; run would fail the whole workflow.
  const bytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;
  if (bytes > WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES) {
    throw new Error(
      `Agent "${call.target}" replied with ${String(bytes)} bytes of JSON, over the ${String(WORKFLOW_PROGRAM_MAX_AGENT_OUTPUT_BYTES)} byte limit for a ctx.agent() result.`,
    );
  }
  return output;
}

export { MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS };
