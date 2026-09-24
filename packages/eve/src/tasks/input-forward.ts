import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { ContextContainer } from "#context/container.js";
import {
  SessionCallbackKey,
  UnsentCallerEventsKey,
  type UnsentCallerEvent,
} from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";
import { isTaskProtocolRefusal } from "#subagents/remote/protocol.js";
import {
  TASK_PROTOCOL_VERSION,
  type TaskInputEvent,
  type TaskInputHookPayload,
} from "#tasks/protocol.js";

const log = createLogger("tasks.input-forward");

const TASK_INPUT_EVENT_TYPES: ReadonlySet<string> = new Set<TaskInputEvent["type"]>([
  "input.requested",
  "input.resolved",
  "approval.candidate",
  "approval.settled",
  "authorization.required",
  "authorization.completed",
]);

function isTaskInputEvent(event: UnstampedMessageStreamEvent): event is TaskInputEvent {
  return TASK_INPUT_EVENT_TYPES.has(event.type);
}

/**
 * The child side of task input: a delegated session sends each human-input
 * event it emits to the caller of its current turn, so the caller can surface
 * it and route answers back. A local caller takes it in its inbox; a remote
 * caller through its callback. A remote forward that fails, or would overtake
 * an earlier failed one, is kept in context and sent again before the session
 * waits for input (`flushUnsentCallerEvents`); retrying it here would re-run
 * the step that emitted it.
 */
export async function forwardTaskInputToCaller(input: {
  readonly ctx: Pick<ContextContainer, "get" | "set">;
  readonly event: UnstampedMessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const { ctx, event, sessionId } = input;
  if (!isTaskInputEvent(event)) return;
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind === SUBAGENT_ADAPTER_KIND && isSubagentAdapterState(adapter.state)) {
    const { callId, parentContinuationToken, subagentName } = adapter.state;
    const payload: TaskInputHookPayload = {
      callId,
      childSessionId: sessionId,
      event,
      kind: "task.input",
      subagentName,
    };
    try {
      await resumeHook(parentContinuationToken, payload);
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      log.warn("the caller of a task input event is gone; the event is dropped", {
        callId,
        eventType: event.type,
      });
    }
  }
  const callback = ctx.get(SessionCallbackKey);
  if (callback === undefined) return;
  const body = {
    callId: callback.callId,
    event,
    kind: "task.input",
    sessionId,
    subagentName: callback.subagentName,
    taskProtocol: TASK_PROTOCOL_VERSION,
  };
  const entry: UnsentCallerEvent = { body, url: callback.url };
  const unsent = ctx.get(UnsentCallerEventsKey) ?? [];
  if (unsent.length === 0 && (await sendCallerEvent(entry, { logFailures: false })) !== "retry") {
    return;
  }
  log.warn("keeping a task input event for the remote caller to send again", {
    callId: callback.callId,
    eventType: event.type,
  });
  ctx.set(UnsentCallerEventsKey, [...unsent, entry]);
}

/**
 * Posts one caller event. `retry` for a transport failure or a status that
 * may clear; a caller that can never take the event (it rejects the body,
 * knows no such callback, or speaks another task protocol version) drops it.
 */
export async function sendCallerEvent(
  entry: UnsentCallerEvent,
  options: { readonly logFailures: boolean },
): Promise<"sent" | "dropped" | "retry"> {
  let response: Response;
  try {
    response = await postSessionCallbackRequest({
      body: entry.body,
      logFailures: options.logFailures,
      url: entry.url,
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "sent";
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 410 ||
    (await isTaskProtocolRefusal(response))
  ) {
    log.warn("the remote caller refused a task input event; it is dropped", {
      callId: entry.body.callId,
      kind: entry.body.kind,
      status: response.status,
    });
    return "dropped";
  }
  return "retry";
}
