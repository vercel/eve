import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/session/state.js";
import { emitTurnEvent } from "#execution/turn/events.js";
import {
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
  type InboxResponseRoute,
} from "#harness/proxy-input-requests.js";
import { createInputRequestedEvent } from "#protocol/message.js";
import { isInputRequest } from "#shared/input.js";
import type { TaskInputRequestDelivery } from "#tasks/types.js";

interface ProxyEventContext {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Child prompts and authorization are progress; the owning turn remains open for replies. */
export async function runProxySubagentEvent(
  input: ProxyEventContext & {
    readonly inboxResponse?: InboxResponseRoute;
    readonly hookPayload: SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
  },
) {
  const { hookPayload } = input;
  let sessionState = input.sessionState;
  if (hookPayload.kind === "subagent-input-request") {
    const session = readDurableSession(sessionState);
    const entries = toProxyInputRequestEntries(hookPayload);
    const state = upsertProxyInputRequestState({
      entries:
        input.inboxResponse === undefined
          ? entries
          : entries.map(([requestId, route]) => [
              requestId,
              { ...route, inboxResponse: input.inboxResponse },
            ]),
      forChildContinuationToken: hookPayload.childContinuationToken,
      state: session.state,
    });
    sessionState = replaceDurableSessionSnapshot({ session: { ...session, state } });
  }
  return await emitTurnEvent({
    events: input.parentWritable,
    event:
      hookPayload.kind === "subagent-input-request"
        ? createInputRequestedEvent(hookPayload.event)
        : hookPayload.event,
    serializedContext: input.serializedContext,
    sessionState,
  });
}

/** Task ownership and response routes were validated before this event is displayed. */
export async function emitRecordedTaskInputRequest(
  input: ProxyEventContext & {
    readonly request: TaskInputRequestDelivery;
  },
) {
  const requests = input.request.requests ?? [input.request.request];
  if (requests.length === 0 || !requests.every(isInputRequest))
    throw new Error("Recorded task input requests are invalid.");
  return await emitTurnEvent({
    events: input.parentWritable,
    event: createInputRequestedEvent({
      requests,
      sequence: input.request.sequence,
      stepIndex: input.request.stepIndex,
      turnId: input.request.turnId,
    }),
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
}
