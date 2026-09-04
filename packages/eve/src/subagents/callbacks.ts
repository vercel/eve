import type { SessionCallback, SubagentAuthorizationEvent } from "#channel/types.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { SessionCallbackKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { SESSION_FAILED } from "#subagents/agent-handle-errors.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const log = createLogger("execution.session-callback");

/** Sends task-owned remote HITL and authorization events to the parent callback capability. */
export async function fireTaskEventCallback(input: {
  readonly callback: unknown;
  readonly childContinuationToken: string;
  readonly childSessionId: string;
  readonly event:
    | SubagentAuthorizationEvent
    | Extract<UnstampedMessageStreamEvent, { type: "input.requested" }>;
}): Promise<void> {
  const callback = parseSerializedSessionCallback(input.callback);
  if (callback.taskId === undefined) return;
  const inputRequested = input.event.type === "input.requested";
  const kind = inputRequested ? "task.input-requested" : "task.authorization";
  const response = await postSessionCallbackRequest({
    body: {
      callId: callback.callId,
      childContinuationToken: input.childContinuationToken,
      childSessionId: input.childSessionId,
      event: inputRequested ? input.event.data : input.event,
      kind,
      subagentName: callback.subagentName,
      taskId: callback.taskId,
    },
    url: callback.url,
  });
  if (!response.ok) {
    throw new Error(`Task event callback failed with HTTP ${response.status}.`);
  }
}

/** Sends one remote task progress update over its existing parent callback. */
export async function fireTaskUpdateCallback(input: {
  readonly callback: unknown;
  readonly callId: string;
  readonly updateIndex: number;
  readonly updateEpoch: string;
  readonly message: string;
}): Promise<string | undefined> {
  const callback = parseSerializedSessionCallback(input.callback);
  if (callback.taskId === undefined) return undefined;
  const response = await postSessionCallbackRequest({
    body: {
      callId: input.callId,
      updateIndex: input.updateIndex,
      updateEpoch: input.updateEpoch,
      kind: "task.update",
      message: input.message,
      taskId: callback.taskId,
    },
    url: callback.url,
  });
  if (!response.ok) {
    throw new Error(`Task update callback failed with HTTP ${response.status}.`);
  }
  return callback.taskId;
}

/** Sends the configured terminal callback within the owner's settlement decision. */
export async function fireSessionCallback(input: {
  readonly error?: unknown;
  readonly output?: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly status: "completed" | "failed";
  readonly usage?: TokenUsage;
}): Promise<void> {
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const value = input.serializedContext[SessionCallbackKey.name];
  if (value === undefined) {
    return;
  }

  try {
    const callback = parseSerializedSessionCallback(value);
    const body =
      input.status === "completed"
        ? buildCompletedCallbackBody({
            callback,
            output: input.output,
            sessionId,
            usage: input.usage,
          })
        : {
            callId: callback.callId,
            error: {
              code: SESSION_FAILED,
              message: toErrorMessage(input.error),
            },
            kind: "session.failed" as const,
            sessionId,
            subagentName: callback.subagentName,
            usage: input.usage,
          };

    const response = await postSessionCallbackRequest({ body, url: callback.url });

    if (!response.ok) {
      throw new Error(`Session callback failed with HTTP ${response.status}.`);
    }
  } catch (error) {
    log.error("failed to post session callback", {
      error,
      sessionId,
    });
    throw error;
  }
}

function buildCompletedCallbackBody(input: {
  readonly callback: SessionCallback;
  readonly output: unknown;
  readonly sessionId: string;
  readonly usage: TokenUsage | undefined;
}): Record<string, unknown> {
  const base = {
    callId: input.callback.callId,
    kind: "session.completed" as const,
    output: input.output ?? "",
    sessionId: input.sessionId,
    subagentName: input.callback.subagentName,
  };
  return input.usage === undefined ? base : { ...base, usage: input.usage };
}

function parseSerializedSessionCallback(value: unknown): SessionCallback {
  const parsed = parseSessionCallback(value);
  if (!parsed.ok) {
    throw new Error("Serialized session callback is invalid.", {
      cause: parsed.cause,
    });
  }

  return parsed.callback;
}
