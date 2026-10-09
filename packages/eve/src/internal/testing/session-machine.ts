import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { grantedApprovalKeys, parkOnApprovals } from "#harness/hitl/approvals.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import { eventsOf } from "#harness/publication.js";
import {
  ensureSessionProjection,
  recordPublishedEvent,
  saveProjection,
  stepProjection,
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
import { initialSessionProjection } from "#protocol/session-projection.js";
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
  const projection = stepProjection(undefined, session.state);
  for (const event of events) projection.record(event);
  return saveProjection(session, projection.read());
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
  const parkedStep = {
    event,
    messages: step.messages ?? [],
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
export function foldingHandler(handleEvent?: TestEventHandler): HarnessEmitFn {
  return async (publication, messages) => {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      ensureSessionProjection(ctx, undefined);
      for (const event of eventsOf(publication)) recordPublishedEvent(ctx, event);
    }
    if (handleEvent !== undefined) await eachEvent(handleEvent)(publication, messages);
  };
}

/** A test's event handler: one event at a time, with the conversation its participants read. */
export type TestEventHandler = (
  event: UnstampedMessageStreamEvent,
  messages?: readonly ModelMessage[],
) => void | Promise<void>;

/**
 * Adapts a test's per-event handler to the harness's sink, which publishes a transition's events
 * as one commit: the handler hears each event in order.
 */
export function eachEvent(handler: TestEventHandler): HarnessEmitFn {
  return async (publication, messages) => {
    for (const event of eventsOf(publication)) await handler(event, messages);
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
