import { SessionIdKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  publishSessionEvents,
  writeSessionEventBeforeDispatch,
  type PendingSessionEventDispatch,
  type SessionStepState,
  type WritableBeforeDispatchEvent,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { EarlyWritableRunMessage } from "#execution/tools/workflow/early-write.js";
import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  createAgentStartedEvent,
  type AgentStartedStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/** Publishes a workflow tool run's `ctx.report()` update as `action.partial`. */
export async function emitWorkflowToolRunReportStep(
  input: SessionStepState & {
    readonly from: WorkflowToolRunRef;
    readonly update: JsonValue;
  },
): Promise<SessionStateTransition> {
  "use step";

  const event = createActionPartialEvent({
    result: createRuntimeToolResultFromValue({
      callId: input.from.callId,
      output: input.update,
      toolName: input.from.toolName,
    }),
    sequence: input.from.sequence,
    stepIndex: input.from.stepIndex,
    turnId: input.from.turnId,
  });
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, [event]));
}

/** Publishes `agent.started` for a session a workflow tool run opened. */
export async function emitAgentStartedStep(
  input: SessionStepState & {
    readonly message: WorkflowToolRunAgentStartedMessage;
  },
): Promise<SessionStateTransition> {
  "use step";

  const event = agentStartedEvent(input.message, input.sessionState.sessionId);
  return await withSessionStateDelta(input, (target) => publishSessionEvents(target, [event]));
}

/**
 * Writes the event of a run message that arrived while a model step owns the
 * session, so clients see it before the step ends. Returns the dispatch the
 * next step that owns the session runs, if anything subscribes to the event.
 */
export async function writeEarlyRunMessageEventStep(input: {
  readonly message: EarlyWritableRunMessage;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<PendingSessionEventDispatch | undefined> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  return await writeSessionEventBeforeDispatch({
    ctx,
    event: earlyRunMessageEvent(input.message, ctx.require(SessionIdKey)),
    sessionWritable: input.sessionWritable,
  });
}

function earlyRunMessageEvent(
  message: EarlyWritableRunMessage,
  sessionId: string,
): WritableBeforeDispatchEvent {
  switch (message.kind) {
    case "agent-started":
      return agentStartedEvent(message, sessionId);
  }
}

function agentStartedEvent(
  message: WorkflowToolRunAgentStartedMessage,
  parentSessionId: string,
): AgentStartedStreamEvent {
  const { from, session } = message;
  return createAgentStartedEvent({
    callId: from.callId,
    name: session.name,
    parentSessionId,
    remote:
      session.kind === "remote"
        ? {
            url: session.url,
            ...(session.resolverId !== undefined && { resolverId: session.resolverId }),
          }
        : undefined,
    sessionId: session.sessionId,
    ...(from.taskId !== undefined && { taskId: from.taskId }),
    turnId: from.turnId,
  });
}
