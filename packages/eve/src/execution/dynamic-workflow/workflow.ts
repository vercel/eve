import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  parseWorkflowProgramOptions,
  readWorkflowProgramAgentCall,
  readWorkflowProgramCallInterrupt,
  type WorkflowProgramAgentCall,
  type WorkflowProgramInput,
} from "#execution/dynamic-workflow/schema.js";
import {
  runWorkflowProgramStep,
  type WorkflowProgramStepOutcome,
} from "#execution/dynamic-workflow/program-step.js";
import { createWorkflowProgramContinuationSecurityStep } from "#execution/dynamic-workflow/security-step.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowTaskContext } from "#tools/workflow-definition.js";

export interface JsProgramOptions {
  /** Maximum child-agent calls, from 1 to 128. Defaults to 100. */
  readonly maxSubagents?: number;
}

/** Runs a model-generated JavaScript function body inside an isolated workflow sandbox. */
export async function runJsProgram(
  js: string,
  ctx: WorkflowTaskContext,
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
      outcome.pending.map(async (pending) => {
        const interrupt = readWorkflowProgramCallInterrupt(pending);
        const call = readWorkflowProgramAgentCall(interrupt.toolInput);
        const invocationIndex = calls++;
        if (invocationIndex >= program.maxSubagents) {
          return {
            status: "failed" as const,
            error: `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most ${String(program.maxSubagents)} agents; "${call.target}" was not called.`,
          };
        }
        try {
          const output = await callProgramAgent(ctx, call);
          return { status: "completed" as const, output };
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          return { status: "failed" as const, error: toErrorMessage(error) };
        }
      }),
    );
    outcome = await runWorkflowProgramStep({
      ...base,
      resume: { interrupt: outcome.interrupt, resolutions },
    });
  }
  return outcome.output;
}

/** Sends one program agent call to a new session and returns that turn's reply. */
async function callProgramAgent(
  ctx: WorkflowTaskContext,
  call: WorkflowProgramAgentCall,
): Promise<JsonValue> {
  const { message, outputSchema } = call.input;
  const response = await ctx
    .agent(call.target)
    .send<JsonValue>(message, { outputSchema, signal: ctx.abortSignal });
  const result = await response.result();
  if (result.status === "failed") {
    throw new Error(`Agent "${call.target}" failed to handle the message.`);
  }
  if (outputSchema !== undefined) return result.data ?? null;
  return result.message ?? null;
}

export { MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS };
