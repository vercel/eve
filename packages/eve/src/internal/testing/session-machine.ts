import { readAnswerText } from "#internal/input-text.js";
import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { grantedApprovalKeys } from "#harness/hitl/approval.js";
import { afterStep, beforeStep } from "#harness/hitl/decisions.js";
import { renderPendingApprovalsSnippet } from "#harness/hitl/index.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import type { Transition } from "#harness/session-machine/commit.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { withoutApprovalParts } from "#harness/step/after-model.js";
import { sessionView, saveTransition } from "#harness/session-machine/commit.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import {
  ensureSessionProjection,
  recordPublishedEvent,
  saveProjection,
} from "#harness/session-machine/current.js";
import {
  SESSION_PROJECTION_STATE_KEY,
  storedProjection,
  suspendedSteps,
  turnPosition,
  type StepCoordinates,
  type SuspendedStep,
  type TurnPosition,
} from "#harness/session-machine/view.js";
import type { HarnessEmitFn, HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";
import {
  createSessionStartedEvent,
  createStepStartedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";

// Fixtures for tests that start a session part-way through its lifecycle. They reach that
// state the way a session does, by folding what it would have published and by the machine's
// own transitions, so a test never seeds a shape the machine can't produce.

/** The session as publishing `events` leaves it. */
export function withPublished(
  session: HarnessSession,
  events: readonly UnstampedMessageStreamEvent[],
): HarnessSession {
  return saveProjection(session, events.reduce(foldSession, storedProjection(session.state)));
}

/** The session with `position`'s turn open, at its step. */
export function withOpenTurn(
  session: HarnessSession,
  position: { readonly sequence: number; readonly turnId: string; readonly stepIndex?: number },
): HarnessSession {
  const projection = storedProjection(session.state);
  const events: UnstampedMessageStreamEvent[] = [];
  if (projection.started !== true) events.push(createSessionStartedEvent());
  if (projection.activeTurnId !== position.turnId) {
    events.push(createTurnStartedEvent({ sequence: position.sequence, turnId: position.turnId }));
  }
  if (position.stepIndex !== undefined) {
    events.push(
      createStepStartedEvent({
        modelId: "test-model",
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
    );
  }
  return withPublished(session, events);
}

/**
 * The session parked as a model step parks: its response waits on approvals, runtime calls, or
 * both. An approval-only park ends its turn.
 */
export function withParkedStep(
  session: HarnessSession,
  step: {
    readonly event?: StepCoordinates;
    readonly messages?: readonly ModelMessage[];
    readonly requests?: readonly InputRequest[];
    readonly tasks?: readonly RuntimeWorkflowTaskRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly requester?: SuspendedStep["requester"];
  },
): HarnessSession {
  const event = step.event ?? { sequence: 1, stepIndex: 0, turnId: "turn-1" };
  const opened = withOpenTurn(session, event);
  const view = sessionView(storedProjection(opened.state), opened.state);
  // A response parks without the SDK's approval parts, as the step normalizes it.
  const parkedStep = {
    event,
    messages: withoutApprovalParts(step.messages ?? []),
    tasks: step.tasks ?? [],
  };
  const transition =
    (step.requests ?? []).length === 0
      ? suspendStep(view, parkedStep)
      : parkOnApprovals(view, {
          ...parkedStep,
          requester: step.requester,
          requests: step.requests ?? [],
          responseAuthRequiredRequestIds: step.responseAuthRequiredRequestIds,
        });
  const parked = writeTurnState(
    {
      ...opened,
      history: [...opened.history, ...(transition.commit ?? [])] as typeof opened.history,
    },
    transition.turn,
  );
  return withPublished(parked, transition.events);
}

/**
 * Wraps a test's event handler so the harness's events fold into the step's projection, as the
 * publish sink does in a running session.
 */
export function foldingHandler(handleEvent?: HarnessEmitFn): HarnessEmitFn {
  return async (event, messages) => {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      ensureSessionProjection(ctx, undefined);
      recordPublishedEvent(ctx, event);
    }
    await handleEvent?.(event, messages);
  };
}

/**
 * Session state whose projection sits at `position`: inside its open turn, or between turns when
 * `turnId` is empty, with `sequence` the next turn's.
 */
export function positionState(position: {
  readonly sequence: number;
  readonly stepIndex?: number;
  readonly turnId: string;
}): SessionStateMap {
  if (position.turnId !== "") {
    return withOpenTurn({ state: undefined } as HarnessSession, position).state ?? {};
  }
  return {
    [SESSION_PROJECTION_STATE_KEY]: {
      ...initialSessionProjection(),
      nextSequence: position.sequence,
      started: true,
    },
  };
}

/** The session holding `input` until it can run. */
export function withQueuedInput<T extends Pick<HarnessSession, "state">>(
  session: T,
  input: StepInput,
): T {
  return writeTurnState(session, { ...readTurnState(session.state), queued: input });
}

export function parkedSteps(session: Pick<HarnessSession, "state">): readonly SuspendedStep[] {
  return suspendedSteps(session.state);
}

export function positionOf(session: Pick<HarnessSession, "state">): TurnPosition {
  return turnPosition(storedProjection(session.state));
}

/** The approval keys `once()` approvals granted that no pending approval still asks about. */
export function grantedKeys(
  session: Pick<HarnessSession, "state">,
  approvalKey: (request: InputRequest) => string | undefined = () => undefined,
): ReadonlySet<string> {
  return grantedApprovalKeys(
    sessionView(storedProjection(session.state), session.state),
    approvalKey,
  );
}

/** Parks a fixture through the same live decision and adapter as the model-step seam. */
export function parkOnApprovals(
  view: SessionView,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly requester?: SuspendedStep["requester"];
  },
): Transition {
  const pendingStart = input.messages.findIndex((message) => message.role !== "tool");
  const committed = pendingStart === -1 ? input.messages : input.messages.slice(0, pendingStart);
  const messages = input.messages.slice(committed.length);
  const snippet = renderPendingApprovalsSnippet(input.requests);
  const decision = afterStep(view, {
    at: input.event,
    inputs: [
      {
        type: "approval.requested",
        at: input.event,
        messages,
        requests: input.requests,
        requester: input.requester ?? null,
        approvalKeys: {},
        responsePolicyRequestIds: input.responseAuthRequiredRequestIds ?? [],
      },
      ...(input.tasks.length === 0
        ? []
        : [{ type: "actions.dispatched" as const, at: input.event, messages, tasks: input.tasks }]),
    ],
  });
  const transition = decision.transition;
  return {
    ...transition,
    commit: [
      ...committed,
      ...(snippet === undefined ? [] : [createFrameworkUserMessage("context.state", snippet)]),
      ...(transition.commit ?? []),
    ],
  };
}

/** Child batches arrive through the live HITL decision and machine persistence seam. */
export function withRelayedRequests<
  S extends Pick<import("#harness/types.js").HarnessSessionBase, "state" | "limits">,
>(
  session: S,
  batches: readonly {
    readonly at: StepCoordinates;
    readonly route: import("#harness/hitl/input.js").RelayRoute;
    readonly requests: readonly InputRequest[];
  }[],
): S {
  let current = session;
  for (const batch of batches) {
    const view = sessionView(storedProjection(current.state), current.state);
    const { transition } = beforeStep(view, [{ ...batch, type: "relayed.requested" }]);
    current = saveTransition(
      {
        ...current,
        state: {
          ...current.state,
          [SESSION_PROJECTION_STATE_KEY]: transition.events.reduce(foldSession, view.projection),
        },
      },
      transition,
    );
  }
  return current;
}

/** Private relay routes currently owned by the machine, without legacy hydration. */
export function getRelayedRequests(state: SessionStateMap | undefined) {
  return new Map(Object.entries(readTurnState(state).hitl?.relayedRoutes ?? {}));
}

/** Inspect the live relay decision/outbox, not a compatibility-shaped routed payload. */
export function decideRelayDelivery(input: {
  readonly state?: SessionStateMap;
  readonly payload: import("#channel/types.js").DeliverPayload;
  readonly resolveMessage?: boolean;
}) {
  const view = sessionView(storedProjection(input.state), input.state);
  const text = readAnswerText(input.payload);
  const decision = beforeStep(view, [
    {
      type: "delivery.received",
      responses: input.payload.inputResponses ?? [],
      ...(text !== undefined && { message: { text, delegated: input.resolveMessage !== true } }),
    },
  ]);
  return { decision, ...decision };
}
