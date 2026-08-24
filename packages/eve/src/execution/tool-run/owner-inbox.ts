import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { RunMessage, RunRequest } from "#execution/tool-run/messages.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskRunInboundPayload } from "#tasks/types.js";

/**
 * A `RunMessage` is what a workflow tool run resumes on its owner's hook. It
 * carries `from` and one of three kinds; every other payload the owner reads
 * comes from the framework wire and has a `kind` outside this set.
 */
export function isRunMessage(value: unknown): value is RunMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { from?: unknown; kind?: unknown };
  if (typeof candidate.from !== "object" || candidate.from === null) return false;
  return (
    candidate.kind === "outcome" || candidate.kind === "report" || candidate.kind === "request"
  );
}

/**
 * Binds a run's terminal outcome to its call as a `tool-result`, the same
 * shape an owner already binds from the runtime-action wire. A cancelled run
 * settles the call as an error so a self-cancelling body never leaves the
 * owner waiting.
 */
export function runOutcomeToToolResult(
  message: Extract<RunMessage, { kind: "outcome" }>,
): RuntimeToolResultActionResult {
  const { from, result } = message;
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
  message: Extract<RunMessage, { kind: "request" }>,
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

function normalizeInputRequest(
  request: RunRequest,
  from: RunMessage["from"],
  requestId: string,
): InputRequest {
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

/**
 * Rewrites a run's message into the payloads a durable task run already
 * consumes, so a background workflow tool reports through the same state
 * machine as any other executor: its outcome completes or fails the task, a
 * report wakes the owning agent, and a request is proxied to the parent.
 */
export function runMessageToTaskPayload(
  message: RunMessage,
  taskId: string,
  nextUpdateIndex: () => number,
): TaskRunInboundPayload {
  if (message.kind === "report") {
    return {
      callId: message.from.callId,
      kind: "task-update",
      message: typeof message.update === "string" ? message.update : JSON.stringify(message.update),
      updateEpoch: taskId,
      updateIndex: nextUpdateIndex(),
    };
  }
  if (message.kind === "request") {
    return runRequestToInputRequestPayload(message);
  }
  const { result } = message;
  if (result.status === "completed") {
    return {
      command: { data: result.output, kind: "complete", lifecycle: "terminal" },
      kind: "task-command",
    };
  }
  if (result.status === "failed") {
    return {
      command: { data: errorMessage(result.error), kind: "fail", lifecycle: "terminal" },
      kind: "task-command",
    };
  }
  return { command: { kind: "settle-executor" }, kind: "task-command" };
}
