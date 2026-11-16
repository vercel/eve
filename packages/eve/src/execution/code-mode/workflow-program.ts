import { callProgramAgent } from "#execution/code-mode/agent-call.js";
import { agentLimitMessage, PROGRAM_MAX_AGENT_CALLS } from "#execution/code-mode/limits.js";
import { programFailure, programResult } from "#execution/code-mode/result.js";
import {
  createWorkflowProgramSecurityStep,
  runWorkflowProgramStep,
  type WorkflowProgramCallResult,
  type WorkflowProgramStepInput,
} from "#execution/code-mode/workflow-program-step.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject, type JsonValue } from "#shared/json.js";
import type { WorkflowToolContext } from "#tools/workflow-definition.js";

// The `workflow()` tool: a program the model writes, run in the background as a task. It is the
// language `eve__execute` runs in the turn, with one difference that follows from where it runs:
// a workflow has no session, so `tools` holds agents only.

/** How much console output a failed program's message carries. */
const MAX_FAILURE_LOG_CHARS = 4_000;

/** What the author of a `workflow()` tool sets. */
export interface WorkflowProgramOptions {
  /** Agent calls one program may make, from 1 to {@link PROGRAM_MAX_AGENT_CALLS}. */
  readonly maxSubagents: number;
}

/** The input a `workflow()` call starts its run with: the model's code and the author's limit. */
export interface WorkflowProgramTaskInput {
  readonly code: string;
  readonly maxSubagents?: number;
}

export function parseWorkflowProgramOptions(value: unknown): WorkflowProgramOptions {
  const { maxSubagents } = parseJsonObject(value);
  if (
    typeof maxSubagents !== "number" ||
    !Number.isSafeInteger(maxSubagents) ||
    maxSubagents < 1 ||
    maxSubagents > PROGRAM_MAX_AGENT_CALLS
  ) {
    throw new TypeError(
      `workflow maxSubagents must be an integer between 1 and ${String(PROGRAM_MAX_AGENT_CALLS)}.`,
    );
  }
  return { maxSubagents };
}

/** The workflow every `workflow()` tool call runs. */
export async function runWorkflowProgramTask(
  input: WorkflowProgramTaskInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  "use workflow";

  return await runWorkflowProgram(input, ctx);
}

/**
 * Runs the program to its end: each time it waits on agents, sends each its message in a new
 * session, then resumes the program with the replies. A program that fails, fails its task.
 */
export async function runWorkflowProgram(
  input: WorkflowProgramTaskInput,
  ctx: WorkflowToolContext,
): Promise<JsonValue> {
  if (typeof input.code !== "string") throw new TypeError('workflow requires a "code" string.');
  const { maxSubagents } = parseWorkflowProgramOptions({
    maxSubagents: input.maxSubagents ?? PROGRAM_MAX_AGENT_CALLS,
  });
  const base: WorkflowProgramStepInput = {
    callId: ctx.callId,
    code: input.code,
    security: await createWorkflowProgramSecurityStep(),
  };
  const calls: Record<string, number> = {};
  let agentCalls = 0;
  let outcome = await runWorkflowProgramStep(base);
  while (outcome.status === "interrupted") {
    ctx.abortSignal.throwIfAborted();
    const resolutions = await Promise.all(
      outcome.pending.map(async ({ call, interruptionId }) => {
        let value: WorkflowProgramCallResult;
        if (agentCalls++ >= maxSubagents) {
          value = { error: agentLimitMessage(maxSubagents, call.target), status: "failed" };
        } else {
          try {
            value = { output: await callProgramAgent(call, ctx, call.target), status: "completed" };
          } catch (error) {
            ctx.abortSignal.throwIfAborted();
            value = { error: toErrorMessage(error), status: "failed" };
          }
        }
        calls[value.status] = (calls[value.status] ?? 0) + 1;
        return { interruptionId, value };
      }),
    );
    outcome = await runWorkflowProgramStep({
      ...base,
      resume: { continuation: outcome.continuation, resolutions },
    });
  }
  if (outcome.status === "completed") return programResult(outcome, calls);
  // A failed task carries one message, so what the program logged goes with it.
  const logs = outcome.logs.length > 0 ? `\nconsole output:\n${outcome.logs.join("\n")}` : "";
  throw new Error(`${programFailure(outcome.error, calls)}${logs.slice(0, MAX_FAILURE_LOG_CHARS)}`);
}
