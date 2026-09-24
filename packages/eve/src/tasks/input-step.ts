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
import {
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import { createInputResolvedEvent, type InputResolution } from "#protocol/message.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { applyTaskInputEvent, type TaskAnswers } from "#tasks/input.js";
import type { TaskInputEvent, TaskInputRequest } from "#tasks/protocol.js";
import { getTaskTable, readTaskCallbackAlias, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, findTask } from "#tasks/table.js";
import { answerTask } from "#tasks/transport.js";

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
 * Surfaces a child's human-input event with the task's ID and records the
 * requests the task waits on. The event goes through this session's own
 * sink, which passes it on to this session's caller when it has one.
 */
export async function surfaceTaskInputStep(
  input: TaskInputSurface & { readonly event: TaskInputEvent; readonly taskId: string },
): Promise<TaskInputTransition> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  return await publishTaskInput(ctx, input, [{ event: input.event, taskId: input.taskId }]);
}

/**
 * Sends each task the answers meant for it. A child session announces the
 * requests it resolves; a workflow run's question resolves as its hook takes
 * the answer, so the owner announces that resolution itself.
 */
export async function answerTaskInputStep(
  input: TaskInputSurface & {
    readonly answers: readonly TaskAnswers[];
    readonly delivery: DeliverHookPayload;
  },
): Promise<Partial<TaskInputTransition>> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const callbackAlias = readTaskCallbackAlias(readDurableSession(input.sessionState).state);
  const resolved: { readonly event: TaskInputEvent; readonly taskId: string }[] = [];
  for (const answers of input.answers) {
    await answerTask({ answers, callbackAlias, ctx, delivery: input.delivery });
    if (answers.record.child?.kind !== "workflow") continue;
    const taskId = answers.record.id;
    resolved.push(...resolutionEvents(answers).map((event) => ({ event, taskId })));
  }
  return resolved.length === 0 ? {} : await publishTaskInput(ctx, input, resolved);
}

async function publishTaskInput(
  ctx: ContextContainer,
  input: TaskInputSurface,
  events: readonly { readonly event: TaskInputEvent; readonly taskId: string }[],
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
        // A question or sign-in ends a conversation turn's stream, as the session's own do.
        if (
          mode === "conversation" &&
          (event.type === "input.requested" || event.type.startsWith("authorization."))
        ) {
          const emission = await emitTurnEpilogue(emit, getHarnessEmissionState(next.state), mode);
          next = setHarnessEmissionState(next, emission);
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
        ({ dismissible: _dismissible, ...request }: TaskInputRequest) => request,
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

/** One `input.resolved` per batch the answers resolve, with the batch's coordinates. */
function resolutionEvents(answers: TaskAnswers): TaskInputEvent[] {
  const responses = new Map(answers.responses.map((response) => [response.requestId, response]));
  const dismissed = new Set(answers.dismissed);
  return (answers.record.input ?? []).flatMap((batch) => {
    const resolutions = batch.requests.flatMap((request): InputResolution[] => {
      const { kind, requestId } = request;
      const response = responses.get(requestId);
      if (response !== undefined) return [{ kind, outcome: "answered", requestId, response }];
      return dismissed.has(requestId) ? [{ kind, outcome: "ignored", requestId }] : [];
    });
    if (resolutions.length === 0) return [];
    const { sequence, stepIndex, turnId } = batch;
    return [createInputResolvedEvent({ resolutions, sequence, stepIndex, turnId })];
  });
}
