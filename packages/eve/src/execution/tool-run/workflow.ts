import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { attachRunContext, type RunOutcome, type RunRef } from "#execution/tool-run/messages.js";
import { tell } from "#execution/tool-run/tell.js";
import { openRunControlInbox } from "#execution/tool-run/run-control.js";
import type { ToolRunReplyTo, ToolRunWorkflowInput } from "#execution/tool-run/types.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";

type WorkflowToolExecute = (
  input: unknown,
  ctx: ToolContext,
) => Promise<JsonValue> | AsyncIterable<JsonValue>;

/**
 * Runs one authored workflow tool call.
 *
 * The authored `execute` body was registered by the bundler as a workflow
 * function; this run looks it up, builds the `ctx` it sees, and calls it. The
 * body speaks to its owner — the parked turn or the owning task — over one
 * hook, `ctx.replyTo`: each `yield` is a progress report, `ask` sends a
 * question, and the return value (or a throw) is the single terminal outcome.
 *
 * The run's own hook is its identity claim and its control inbox: a duplicate
 * start loses the claim and exits, and a `cancel` message aborts
 * `ctx.abortSignal` so the body can unwind through `finally` before the run
 * ends. The hook is disposed on teardown so a late control message fails
 * loudly instead of queueing against a finished run.
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
    const replyTo = ownerToken(input.replyTo);
    const from: RunRef = {
      callId: input.callId,
      input: input.input,
      runId,
      stepIndex: input.stepIndex,
      toolName: input.toolName,
      turnId: input.session.turn.id,
    };
    const ctx = createWorkflowToolContext({ from, input, replyTo, signal: control.signal });
    attachRunContext(ctx, { from });

    let outcome: RunOutcome;
    try {
      // Race the control read so a cancel trips `ctx.abortSignal` and settles
      // the run as cancelled even when the body is parked on a hook or sleep.
      const output = await Promise.race([runBody(input, ctx, from, replyTo), control.cancelled]);
      outcome = { output, status: "completed" };
    } catch (error) {
      outcome = control.signal.aborted
        ? { reason: control.reason(), status: "cancelled" }
        : { error: normalizeSerializableError(error), status: "failed" };
    }

    await tell(replyTo, { from, kind: "outcome", result: outcome });
  } finally {
    if (ownsInbox) await disposeHook(control.hook);
  }
}

/** Runs the body, streaming an async generator's yields as progress reports. */
async function runBody(
  input: ToolRunWorkflowInput,
  ctx: ToolContext,
  from: RunRef,
  replyTo: string,
): Promise<JsonValue> {
  const execute = resolveWorkflowToolExecute(input);
  const result = execute(input.input, ctx);
  if (!isAsyncIterable(result)) return await result;

  // Iterate by hand so the generator's return value becomes the tool result,
  // falling back to its last yield when the body only streams. `for await`
  // discards the return, so it cannot be used here.
  const iterator = result[Symbol.asyncIterator]();
  let last: JsonValue | undefined;
  let next = await iterator.next();
  while (next.done !== true) {
    last = next.value;
    await tell(replyTo, { from, kind: "report", update: next.value });
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

/** The owner's hook token: the parked turn's inbox, or the owning task's inbox. */
function ownerToken(replyTo: ToolRunReplyTo): string {
  return replyTo.kind === "turn" ? replyTo.inboxToken : replyTo.taskInboxToken;
}

function readRunId(): string {
  const runId = getWorkflowMetadata().workflowRunId;
  if (typeof runId !== "string") {
    throw new Error("The tool run has no workflow run id.");
  }
  return runId;
}

/**
 * The bundler registers every authored `"use workflow"` function in the
 * driver's workflow registry under its id; the tool's `execute` is one of
 * them. A missing entry means the deployment running this run no longer has
 * the tool under that id.
 */
function resolveWorkflowToolExecute(input: ToolRunWorkflowInput): WorkflowToolExecute {
  const registry = (globalThis as { __private_workflows?: Map<string, unknown> })
    .__private_workflows;
  const execute = registry?.get(input.workflowId);
  if (typeof execute !== "function") {
    throw new Error(
      `Tool "${input.toolName}" is not registered as a workflow in this deployment (${input.workflowId}). ` +
        "The tool was renamed or removed after this run started.",
    );
  }
  return execute as WorkflowToolExecute;
}

function createWorkflowToolContext(options: {
  readonly from: RunRef;
  readonly input: ToolRunWorkflowInput;
  readonly replyTo: string;
  readonly signal: AbortSignal;
}): ToolContext {
  const { from, replyTo, signal } = options;
  const { callId, session, toolName } = options.input;

  return {
    abortSignal: signal,
    callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getSkill: () => unavailable("getSkill()", "skills are read through the session sandbox"),
    getToken: () =>
      unavailable("getToken()", 'read credentials from the environment inside a "use step" helper'),
    replyTo,
    requireAuth: () => unavailable("requireAuth()", "a workflow body cannot park on authorization"),
    session: {
      auth: session.auth,
      id: session.id,
      parent: session.parent,
      turn: session.turn,
    },
    toolName,
  };

  function unavailable(member: string, hint: string): never {
    throw new Error(
      `ctx.${member} is not available inside a workflow tool; ${hint}. ` +
        `Tool "${from.toolName}" runs as a durable workflow body, which only replays deterministic code.`,
    );
  }
}
