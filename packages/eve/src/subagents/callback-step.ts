import type { SessionCallback, SubagentAuthorizationEvent } from "#channel/types.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

/** Sends task-owned remote HITL and authorization events to the parent callback capability. */
export async function fireTaskEventCallbackStep(input: {
  readonly callback: unknown;
  readonly childContinuationToken: string;
  readonly childSessionId: string;
  readonly event:
    | SubagentAuthorizationEvent
    | Extract<UnstampedMessageStreamEvent, { type: "input.requested" }>;
}): Promise<void> {
  "use step";

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

function parseSerializedSessionCallback(value: unknown): SessionCallback {
  const parsed = parseSessionCallback(value);
  if (!parsed.ok) {
    throw new Error("Serialized session callback is invalid.", {
      cause: parsed.cause,
    });
  }

  return parsed.callback;
}
