import type { DeliverPayload, SessionAuthContext, SessionCommand } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { routeDeliverPayload } from "#execution/subagent-hitl-proxy.js";
import { sendTaskInboundPayload } from "#execution/tasks/run-control.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#runtime/input/types.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

/** Validates task routes and forwards descendant-bound input responses. */
export async function routeProxiedDeliverStep(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payload: DeliverPayload;
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<RoutedDeliverResult> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  // A task-owned route is only routable while this session still owns
  // the task; anything else stays parent-local and reaches the model as
  // ordinary stale input.
  const routed = routeDeliverPayload({
    allowRoute: (_requestId, route) =>
      route.taskId === undefined ||
      findSessionTaskEntry(durableSession.state, route.taskId) !== undefined,
    payload: input.payload,
    state: durableSession.state,
  });

  const strandedResponses: InputResponse[] = [];
  for (const forChild of routed.forChildren) {
    // Task-owned children are addressed through their run, never
    // directly: the run must forward and clear the batch under one
    // durable decision, or a late answer could unblock a question the
    // child raised after this one.
    if (forChild.taskId !== undefined) {
      const entry = findSessionTaskEntry(durableSession.state, forChild.taskId);
      const delivery =
        entry === undefined
          ? "unreachable"
          : await sendTaskInboundPayload({
              commandToken: entry.commandToken,
              payload: {
                auth: input.auth,
                childContinuationToken: forChild.childContinuationToken,
                childResponseUrl: forChild.childResponseUrl,
                inputResponses: forChild.payload.inputResponses,
                kind: "task-answer-input",
                taskId: forChild.taskId,
              },
            });
      if (delivery === "unreachable") strandedResponses.push(...forChild.payload.inputResponses);
      continue;
    }

    const command = {
      auth: input.auth,
      kind: "send",
      payload: forChild.payload,
    } satisfies SessionCommand;
    await resumeHook(forChild.childContinuationToken, command);
  }

  const context = {
    serializedContext: input.serializedContext ?? {},
    sessionState: input.sessionState,
  };
  // Answers to a task that finished mid-flight rejoin the parent-local
  // remainder, where the model sees them as stale rather than silently
  // vanishing.
  const remainder =
    strandedResponses.length === 0
      ? routed.forSelf
      : ({
          ...routed.forSelf,
          inputResponses: [...(routed.forSelf?.inputResponses ?? []), ...strandedResponses],
        } satisfies DeliverPayload);
  return routed.parentAction === undefined
    ? { ...context, kind: "continue", remainder }
    : { ...context, ...routed.parentAction };
}
