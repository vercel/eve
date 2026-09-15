import {
  DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  parseWorkflowProgramOptions,
  readWorkflowProgramAgentCall,
  readWorkflowProgramCallInterrupt,
  type WorkflowProgramInput,
  type WorkflowProgramOptions,
} from "#execution/dynamic-workflow/schema.js";
import {
  runWorkflowProgramStep,
  type WorkflowProgramStepOutcome,
} from "#execution/dynamic-workflow/program-step.js";
import { createWorkflowProgramContinuationSecurityStep } from "#execution/dynamic-workflow/security-step.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

export interface JsProgramOptions extends Omit<WorkflowProgramOptions, "maxSubagents"> {
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
    agents: options.agents,
    maxSubagents: options.maxSubagents ?? DEFAULT_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  });
  const program: WorkflowProgramInput = {
    ...optionsWithDefaults,
    continuationSecurity: await createWorkflowProgramContinuationSecurityStep(),
    js,
  };
  const allowedAgents = new Set(program.agents);
  const base = { callId: ctx.callId, program };
  let outcome: WorkflowProgramStepOutcome = await runWorkflowProgramStep(base);
  let calls = 0;
  while (outcome.status === "interrupted") {
    ctx.abortSignal.throwIfAborted();
    const resolutions = await Promise.all(
      outcome.pending.map(async (pending) => {
        const interrupt = readWorkflowProgramCallInterrupt(pending);
        const call = readWorkflowProgramAgentCall(interrupt.toolInput);
        if (!allowedAgents.has(call.target)) {
          return {
            status: "failed" as const,
            error: `WORKFLOW_PROGRAM_AGENT_NOT_ALLOWED: Agent "${call.target}" is not in the workflow allowlist.`,
          };
        }
        const invocationIndex = calls++;
        if (invocationIndex >= program.maxSubagents) {
          return {
            status: "failed" as const,
            error: `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED: workflow may invoke at most ${String(program.maxSubagents)} agents; "${call.target}" was not called.`,
          };
        }
        try {
          const output = await ctx.agent(call.target, call.input);
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

export { MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS };
