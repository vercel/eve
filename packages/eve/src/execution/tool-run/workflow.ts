import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

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
import { resumeHook } from "#execution/tool-run/workflow-api.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { ToolContext } from "#tools/definition.js";
import type { JsonValue } from "#shared/json.js";
import type {
  RuntimeSubagentChildResult,
  RuntimeSubagentDispatchFailure,
  RuntimeSubagentResult,
} from "#shared/action-types.js";
import { SubagentRelayError } from "#execution/tools/subagent/workflow.js";

type WorkflowToolExecute = (
  input: unknown,
  ctx: ToolContext,
) => Promise<JsonValue | RuntimeSubagentResult> | AsyncIterable<JsonValue>;

/**
 * Runs one authored workflow tool call.
 *
 * The authored `execute` body was registered by the bundler as a workflow
 * function; this run looks it up, builds the `ctx` it sees, and calls it. The
 * body speaks to its owner — the parked turn or the owning task — on the
 * owner's three hooks, `ctx.owner`: each `yield` resumes `report`, `ask`
 * resumes `request`, and the return value (or a throw) resumes `outcome` once.
 * The framework subagent relay instead sends child events and its terminal
 * result on `report`, preserving their order, then waits for owner release.
 *
 * The run's own hook is its identity claim and its control inbox: a duplicate
 * start loses the claim and exits, and a `cancel` message aborts
 * `ctx.abortSignal` so the body can unwind through `finally` before the run
 * ends. A subagent relay retains the claim through its owner's commit barrier;
 * the hook is then disposed so a late control message cannot queue forever.
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
    const ctx = createWorkflowToolContext({ from, input, signal: control.signal });
    attachRunContext(ctx, { from });
    attachPrivateSubagentContext(ctx, input);

    let outcome: RunOutcome;
    try {
      // Race the control read so a cancel trips `ctx.abortSignal` and settles
      // the run as cancelled even when the body is parked on a hook or sleep.
      const output = await Promise.race([runBody(input, ctx, from), control.cancelled]);
      outcome =
        input.subagent !== undefined && isRuntimeSubagentResult(output)
          ? { result: output, status: "subagent" }
          : { output, status: "completed" };
    } catch (error) {
      outcome = control.signal.aborted
        ? { reason: control.reason(), status: "cancelled" }
        : input.subagent === undefined
          ? { error: normalizeSerializableError(error), status: "failed" }
          : { result: createSubagentRelayFailure(input, error), status: "subagent" };
    }

    if (input.subagent === undefined) {
      const message: RunOutcomeMessage = { from, result: outcome };
      await resumeHook(input.owner.outcome, message);
    } else {
      await resumeHook(input.owner.report, {
        from,
        kind: "subagent-outcome",
        result:
          outcome.status === "subagent"
            ? outcome.result
            : createSubagentRelayFailure(input, outcome),
      } satisfies RunReport);
    }
    if (input.subagent !== undefined && !control.signal.aborted) {
      await Promise.race([control.released, control.cancelled]);
    }
  } finally {
    if (ownsInbox) await disposeHook(control.hook);
  }
}

export function createSubagentRelayFailure(
  input: ToolRunWorkflowInput,
  error: unknown,
): RuntimeSubagentChildResult | RuntimeSubagentDispatchFailure {
  const childAdopted = error instanceof SubagentRelayError && error.childAdopted;
  const relayError = error instanceof SubagentRelayError ? error.relayCause : error;
  const cause =
    typeof relayError === "object" && relayError !== null && "status" in relayError
      ? relayError.status === "failed"
        ? Reflect.get(relayError, "error")
        : "reason" in relayError
          ? relayError.reason
          : "The subagent relay was cancelled."
      : relayError;
  const failure = {
    code: "SUBAGENT_EXECUTION_FAILED",
    message: cause instanceof Error ? cause.message : String(cause),
  };
  if (!childAdopted) {
    return {
      callId: input.callId,
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: failure,
      subagentName: input.subagent!.subagentName,
    };
  }
  return {
    callId: input.callId,
    isError: true,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: "terminal",
      result: {
        error: failure,
        kind: "failed",
      },
      usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
    },
    output: failure,
    subagentName: input.subagent!.subagentName,
  };
}

function attachPrivateSubagentContext(ctx: ToolContext, input: ToolRunWorkflowInput): void {
  if (input.subagent === undefined) return;
  Object.defineProperty(ctx, Symbol.for("eve.subagent-tool-run"), {
    enumerable: false,
    value: input.subagent,
  });
}

/** Runs the body, streaming an async generator's yields as progress reports. */
async function runBody(
  input: ToolRunWorkflowInput,
  ctx: ToolContext,
  from: RunRef,
): Promise<JsonValue | RuntimeSubagentResult> {
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
    const report: RunReport = { from, kind: "progress", update: next.value };
    await resumeHook(input.owner.report, report);
    next = await iterator.next();
  }
  return (next.value as JsonValue | undefined) ?? last ?? null;
}

function isRuntimeSubagentResult(value: unknown): value is RuntimeSubagentResult {
  if (typeof value !== "object" || value === null) return false;
  const { kind, origin } = value as { kind?: unknown; origin?: unknown };
  return kind === "subagent-result" && (origin === "child" || origin === "dispatch");
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
  readonly signal: AbortSignal;
}): ToolContext {
  const { from, signal } = options;
  const { callId, session, toolName } = options.input;

  return {
    abortSignal: signal,
    callId,
    getSandbox: () => unavailable("getSandbox()", "the session sandbox belongs to the turn"),
    getSkill: () => unavailable("getSkill()", "skills are read through the session sandbox"),
    getToken: () =>
      unavailable("getToken()", 'read credentials from the environment inside a "use step" helper'),
    owner: options.input.owner,
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
