import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type {
  RunOutcomeMessage,
  RunRef,
  RunReport,
  RunRequest,
  RunRequestMessage,
} from "#execution/tool-run/messages.js";
import type { RuntimeActionResult, RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import { readTaskUsage, type TaskCommand, type TaskInboundUpdate } from "#tasks/types.js";

/**
 * Translators from a run's public channels into the payloads its owner already
 * understands. Pure and type-only in its imports: this runs in the turn and
 * task driver bodies.
 */

/**
 * Binds a run's terminal outcome to its call as a `tool-result`, the same
 * shape an owner already binds from the runtime-action wire. A cancelled run
 * settles the call as an error so a self-cancelling body never leaves the
 * owner waiting.
 */
export function runOutcomeToActionResult(message: RunOutcomeMessage): RuntimeActionResult {
  const { from, result } = message;
  if (result.status === "subagent") return result.result;
  if (result.status === "completed") {
    return {
      callId: from.callId,
      kind: "tool-result",
      output: result.output,
      toolName: from.toolName,
    };
  }
  const output: JsonValue =
    result.status === "failed"
      ? errorMessage(result.error)
      : (result.reason ?? "The tool run was cancelled.");
  return {
    callId: from.callId,
    isError: true,
    kind: "tool-result",
    output,
    toolName: from.toolName,
  };
}

/** Authored workflow tools always resolve to ordinary tool results. */
export function runOutcomeToToolResult(message: RunOutcomeMessage): RuntimeToolResultActionResult {
  const result = runOutcomeToActionResult(message);
  if (result.kind !== "tool-result") {
    throw new Error(`Tool run "${message.from.toolName}" returned a subagent result unexpectedly.`);
  }
  return result;
}

/** Reads a human-readable message out of a normalized serialized error. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * Rewrites a run's request into the `subagent-input-request` payload owners
 * already proxy to the channel. The per-request answer hook (`message.replyTo`)
 * is both the child continuation token the answer is routed to and the request
 * id, so one resume of that hook reaches the body's awaited hook directly.
 */
export function runRequestToInputRequestPayload(
  message: RunRequestMessage,
): SubagentInputRequestHookPayload {
  const { from, replyTo, request } = message;
  return {
    callId: from.callId,
    childContinuationToken: replyTo,
    childSessionId: from.runId,
    event: {
      requests: [normalizeInputRequest(request, from, replyTo)],
      sequence: 0,
      stepIndex: from.stepIndex,
      turnId: from.turnId,
    },
    kind: "subagent-input-request",
    subagentName: from.toolName,
  };
}

function normalizeInputRequest(request: RunRequest, from: RunRef, requestId: string): InputRequest {
  if ("action" in request && "requestId" in request) {
    // A forwarded child request already carries its action and kind; only the
    // answer id changes to the hook the parent awaits.
    return { ...request, requestId };
  }
  if (typeof request.prompt !== "string" || request.prompt.length === 0) {
    throw new TypeError("A tool run request needs a non-empty `prompt`.");
  }
  const normalized: InputRequest = {
    action: { callId: from.callId, input: from.input, kind: "tool-call", toolName: from.toolName },
    kind: request.kind ?? "question",
    prompt: request.prompt,
    requestId,
  };
  if (request.allowFreeform !== undefined) normalized.allowFreeform = request.allowFreeform;
  if (request.display !== undefined) normalized.display = request.display;
  if (request.options !== undefined) normalized.options = [...request.options];
  return normalized;
}

/** A background run's progress wakes the owning agent as a task update. */
export function runReportToTaskUpdate(
  message: RunReport,
  taskId: string,
  updateIndex: number,
): TaskInboundUpdate {
  if (message.kind !== "progress") {
    throw new Error("Only progress reports become task updates.");
  }
  return {
    callId: message.from.callId,
    kind: "task-update",
    message: typeof message.update === "string" ? message.update : JSON.stringify(message.update),
    updateEpoch: taskId,
    updateIndex,
  };
}

/**
 * A background run's outcome drives the task's lifecycle: completion and
 * failure are terminal commands; a cancelled run settles the executor of a
 * task that is already cancelled.
 */
export function runOutcomeToTaskCommand(message: RunOutcomeMessage): TaskCommand {
  const { result } = message;
  if (result.status === "subagent") {
    const subagent = result.result;
    if (subagent.origin === "child") {
      const usage = readTaskUsage(subagent.outcome.usageDelta);
      switch (subagent.outcome.result.kind) {
        case "succeeded":
          return withTaskUsage(
            { data: subagent.output, kind: "complete", lifecycle: subagent.outcome.kind },
            usage,
          );
        case "failed":
          return withTaskUsage(
            { data: subagent.output, kind: "fail", lifecycle: subagent.outcome.kind },
            usage,
          );
        case "cancelled":
          return withTaskUsage({ kind: "cancel", lifecycle: subagent.outcome.kind }, usage);
      }
    }
    return { data: subagent.output, kind: "fail" };
  }
  if (result.status === "completed") {
    return { data: result.output, kind: "complete", lifecycle: "terminal" };
  }
  if (result.status === "failed") {
    return { data: errorMessage(result.error), kind: "fail", lifecycle: "terminal" };
  }
  return { kind: "settle-executor" };
}

function withTaskUsage(
  command: Extract<TaskCommand, { kind: "complete" | "fail" | "cancel" }>,
  usage: ReturnType<typeof readTaskUsage>,
): TaskCommand {
  return usage === undefined ? command : { ...command, usage };
}
