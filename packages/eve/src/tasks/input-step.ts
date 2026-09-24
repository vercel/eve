import type { DeliverHookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ModeKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { createSessionEventSink } from "#execution/session/event-sink.js";
import { hydrateDurableSession } from "#execution/session.js";
import { emitTurnHeld, getHarnessEmissionState } from "#harness/emission.js";
import { getPendingInputRequestIds } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import { createSessionWaitingEvent } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#shared/input.js";
import {
  admitTaskInputEvent,
  applyTaskInputEvent,
  sentAnswerResolutions,
  type TaskAnswers,
  type TaskInputPublication,
} from "#tasks/input.js";
import type { TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, findTask } from "#tasks/table.js";
import { answerTask } from "#tasks/transport.js";

const log = createLogger("tasks.input");

interface TaskInputTransition {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

interface TaskInputSurface {
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Surfaces a child's human-input event for its task, once admitted against
 * the requests this owner holds (`admitTaskInputEvent`), and returns the
 * requested IDs it refused.
 */
export async function surfaceTaskInputStep(
  input: TaskInputSurface & { readonly event: TaskInputEvent; readonly taskId: string },
): Promise<TaskInputTransition & { readonly refused: readonly string[] }> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const table = getTaskTable(session);
  const unchanged = {
    refused: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
  const record = findTask(table, input.taskId);
  if (record === undefined) return unchanged;
  const admitted = admitTaskInputEvent({
    event: input.event,
    record,
    sessionPending: getPendingInputRequestIds(session.state),
    table,
  });
  const { refused } = admitted;
  if (refused.length > 0) {
    log.warn("a child asked with request IDs already pending elsewhere; they are dropped", {
      requestIds: refused,
      taskId: input.taskId,
    });
  }
  if (admitted.events.length === 0) return { ...unchanged, refused };
  const ctx = await deserializeContext(input.serializedContext);
  const { taskId } = input;
  const events = admitted.events.map((event) => ({ event, taskId }));
  return { ...(await publishTaskInput(ctx, input, events)), refused };
}

/** Publishes input events the owner itself decided for its tasks. */
export async function publishTaskInputStep(
  input: TaskInputSurface & { readonly events: readonly TaskInputPublication[] },
): Promise<TaskInputTransition> {
  "use step";

  return await publishTaskInput(
    await deserializeContext(input.serializedContext),
    input,
    input.events,
  );
}

/**
 * Sends one task the answers meant for it and returns the resolutions to
 * publish once they reached its child (`sentAnswerResolutions`). Each task's
 * send is its own step, and it publishes nothing itself, so neither a failed
 * publish nor another task's failed send sends an answer twice.
 */
export async function answerTaskStep(input: {
  readonly answers: TaskAnswers;
  readonly delivery: DeliverHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}): Promise<readonly TaskInputPublication[]> {
  "use step";

  const sent = await answerTask({
    answers: input.answers,
    ctx: await deserializeContext(input.serializedContext),
    delivery: input.delivery,
    ownerSessionId: input.sessionId,
  });
  return sent === "delivered" ? sentAnswerResolutions(input.answers) : [];
}

/**
 * Emits each event with its task's ID through this session's own sink, which
 * passes it on to this session's caller when it has one, and records what
 * the task then waits on. Between turns the sink stamps the last turn's
 * delivery IDs: the IDs of the turn that started an attached task, but not
 * always of the turn that started a detached one.
 */
async function publishTaskInput(
  ctx: ContextContainer,
  input: TaskInputSurface,
  events: readonly TaskInputPublication[],
): Promise<TaskInputTransition> {
  const effectiveAgent = resolveEffectiveAgentRuntime(ctx.require(BundleKey), ctx);
  const durable = readDurableSession(input.sessionState);
  const sink = createSessionEventSink({
    adapter: ctx.require(ChannelKey),
    ctx,
    sessionId: durable.sessionId,
    sessionWritable: input.sessionWritable,
  });
  const emit = async (event: Parameters<typeof sink.emit>[0]) => void (await sink.emit(event));
  const mode = ctx.require(ModeKey);
  const now = new Date().toISOString();
  let session: HarnessSession;
  try {
    const hydrated = hydrateDurableSession({
      compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
      durable,
      turnAgent: effectiveAgent.turnAgent,
    });
    ({ session } = await withContextScope(ctx, hydrated, async (scoped) => {
      let next = scoped;
      for (const { event, taskId } of events) {
        await emit(withTaskId(event, taskId));
        // A question or sign-in shows a conversation's waiting boundary, as
        // the session's own do. An open turn stays open under its ID: it waits
        // or holds on the task that asked.
        if (
          mode === "conversation" &&
          (event.type === "input.requested" || event.type.startsWith("authorization."))
        ) {
          const emission = getHarnessEmissionState(next.state);
          if (emission.turnId === "") await emit(createSessionWaitingEvent());
          else await emitTurnHeld(emit, emission);
        }
        next = recordTaskInput(next, event, taskId, now);
      }
      return { result: undefined, session: next };
    }));
  } finally {
    sink.release();
  }
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, session),
    }),
  };
}

/**
 * Attributes the event to this owner's task, replacing a descendant's ID.
 * `dismissible` stays on the owner's record: stream consumers and remote
 * callers accept only the public request shape.
 */
function withTaskId(event: TaskInputEvent, taskId: string): TaskInputEvent {
  switch (event.type) {
    case "input.resolved":
      return event;
    case "input.requested": {
      const requests = event.data.requests.map(
        ({ dismissible: _dismissible, ...request }: InputRequest & TaskInputRequest) => request,
      );
      return { ...event, data: { ...event.data, requests, taskId } };
    }
    default:
      return { ...event, data: { ...event.data, taskId } } as TaskInputEvent;
  }
}

/** Applies the owner's snapshot of the requests a task waits on, stopping or resuming its clock. */
function recordTaskInput(
  session: HarnessSession,
  event: TaskInputEvent,
  taskId: string,
  now: string,
): HarnessSession {
  if (event.type !== "input.requested" && event.type !== "input.resolved") return session;
  const table = getTaskTable(session);
  const record = findTask(table, taskId);
  if (record === undefined) return session;
  const input = applyTaskInputEvent(record.input ?? [], event);
  const applied = applyTaskMessage(
    table,
    { generation: record.generation, input, kind: "task.input", taskId },
    now,
  );
  return applied.table === table ? session : setTaskTable(session, applied.table);
}
