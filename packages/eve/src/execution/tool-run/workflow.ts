import { getWorkflowMetadata, sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  attachRunContext,
  type RunOutcome,
  type RunOutcomeMessage,
  type RunRef,
  type RunReport,
} from "#execution/tool-run/messages.js";
import { openRunControlInbox } from "#execution/tool-run/run-control.js";
import type { ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import { resumeHookStep } from "#execution/tool-run/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { readRegisteredWorkflow } from "#execution/workflow-registry.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";

/** How long a cancelled run waits for its body to unwind before it ends. */
const CANCEL_GRACE = "30s";

function noop(): void {}

type WorkflowToolExecute = (
  input: unknown,
  ctx: ToolContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/**
 * Runs one authored workflow tool call. The run's own hook is its identity
 * claim and its control inbox: a duplicate start loses the claim and exits; a
 * `cancel` message aborts `ctx.abortSignal`, and the run waits up to
 * {@link CANCEL_GRACE} for the body to unwind before ending as cancelled, so a
 * body parked on a hook or sleep cannot keep a cancelled run alive.
 */
export async function toolRunWorkflow(input: ToolRunWorkflowInput): Promise<void> {
  "use workflow";

  const control = openRunControlInbox(input.hookToken);
  let ownsInbox = false;

  try {
    try {
      await claimHookOwnership(control.hook);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    const runId = readRunId();
    const from: RunRef = {
      callId: input.callId,
      input: input.input,
      runId,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      turnId: input.session.turn.id,
    };
    const ctx = createWorkflowToolContext(input, control.signal);
    attachRunContext(ctx, { from, owner: input.owner });

    const body = runBody(input, ctx, from);
    // A body abandoned by a lost race must not surface as an unhandled rejection.
    const settled = body.catch(noop);

    let outcome: RunOutcome;
    try {
      // Racing the control read is what drives it; an unawaited durable read
      // is not scheduled under replay, so a cancel would never be observed.
      outcome = { output: await Promise.race([body, control.cancelled]), status: "completed" };
    } catch (error) {
      if (!control.signal.aborted) {
        outcome = { error: normalizeSerializableError(error), status: "failed" };
      } else {
        await Promise.race([settled, workflowSleep(CANCEL_GRACE)]);
        outcome = { reason: control.reason(), status: "cancelled" };
      }
    }

    const message: RunOutcomeMessage = { from, result: outcome };
    // An owner that cancelled the run may have finished before the grace
    // period ended; a cancelled outcome has nobody left to reach.
    await resumeHookStep(input.owner.outcome, message, {
      ifPresent: outcome.status === "cancelled",
    });
  } finally {
    if (ownsInbox) await disposeHook(control.hook);
  }
}

async function runBody(
  input: ToolRunWorkflowInput,
  ctx: ToolContext,
  from: RunRef,
): Promise<JsonValue> {
  const execute = resolveWorkflowToolExecute(input);
  const result = execute(input.input, ctx);
  if (!isAsyncIterable(result)) return await result;

  // `for await` discards a generator's return value; it is the tool result.
  const iterator = result[Symbol.asyncIterator]();
  let last: JsonValue | undefined;
  let next = await iterator.next();
  while (next.done !== true) {
    last = next.value;
    const report: RunReport = { from, update: next.value };
    await resumeHookStep(input.owner.report, report);
    next = await iterator.next();
  }
  return (next.value as JsonValue | undefined) ?? last ?? null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<JsonValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<JsonValue>)[Symbol.asyncIterator] === "function"
  );
}

function readRunId(): string {
  const runId = getWorkflowMetadata().workflowRunId;
  if (typeof runId !== "string") {
    throw new Error("The tool run has no workflow run id.");
  }
  return runId;
}

function resolveWorkflowToolExecute(input: ToolRunWorkflowInput): WorkflowToolExecute {
  const execute = readRegisteredWorkflow(input.workflowId);
  if (typeof execute !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). ` +
        "The tool was renamed or removed after this run started.",
    );
  }
  return execute as WorkflowToolExecute;
}

function createWorkflowToolContext(input: ToolRunWorkflowInput, signal: AbortSignal): ToolContext {
  const { callId, session, toolName } = input;
  const unavailable = (member: string, hint: string): never => {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. ` +
        `Tool "${toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  };

  return {
    abortSignal: signal,
    callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getSkill: () => unavailable("getSkill()", "skills are read through the session sandbox"),
    getToken: () =>
      unavailable("getToken()", 'read credentials from the environment inside a "use step" helper'),
    requireAuth: () => unavailable("requireAuth()", "a workflow body cannot park on authorization"),
    session,
    toolName,
  };
}
