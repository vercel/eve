import { viewOfEvents } from "#protocol/session-projection/fold.js";
import type { SessionView as PublicSessionView } from "#protocol/session-projection/tables.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { askApprovals } from "#harness/hitl/approvals.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { writeHitlState, type RelayChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import { eventsOf } from "#harness/publication.js";
import {
  ensureSessionProjection,
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
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessStepInput,
  SessionStateMap,
} from "#harness/types.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";

// Fixtures for tests that start a session part-way through its lifecycle. They reach that
// state the way a session does, by folding what it would have published and by the machine's
// own transitions, so a test never seeds a shape the machine can't produce.

/** The session as publishing `events` leaves it. */
export function withPublished(
  session: HarnessSession,
  events: readonly SessionEvent[],
): HarnessSession {
  const projection = stepProjection(undefined, session.state);
  projection.record(events);
  return saveProjection(session, projection.read());
}

/** The session with `position`'s turn open, at its step. */
export function withOpenTurn(
  session: HarnessSession,
  position: { readonly sequence: number; readonly turnId: string; readonly stepIndex?: number },
): HarnessSession {
  // A real session names each turn by the sequence it mints, so a fixture that opens a later turn
  // first counts the turns before it.
  const stored = storedProjection(session.state);
  const projection =
    stored.view.session.turnCount < position.sequence && activeTurnIdOf(stored) !== position.turnId
      ? {
          ...stored,
          view: {
            ...stored.view,
            session: { ...stored.view.session, turnCount: position.sequence },
          },
        }
      : stored;
  session = saveProjection(session, projection);
  const events: SessionEvent[] = [];
  if (projection.view.session.status === "new") events.push({ type: "session.started", data: {} });
  if (activeTurnIdOf(projection) !== position.turnId) {
    events.push({
      type: "turn.started",
      data: {
        turnId: position.turnId,
        follows: latestTurnIdOf(projection) ?? null,
        cause: { hook: "test" },
      },
    });
  }
  if (position.stepIndex !== undefined) {
    const runId = `test_${position.turnId}_${position.stepIndex}`;
    const scope = { runId, turnId: position.turnId };
    events.push(
      { type: "model.requested", data: { runId, owner: { turnId: position.turnId } }, scope },
      { type: "model.started", data: { attempt: 0, runId, modelId: "test-model" }, scope },
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
    readonly requests?: readonly ApprovalAsk[];
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
      : askApprovals(view, {
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
      stepProjection(ctx, undefined).record(publication);
    }
    if (handleEvent !== undefined) await eachEvent(handleEvent)(publication, messages);
  };
}

/** A test's event handler: one event at a time, with the conversation its participants read. */
export type TestEventHandler = (
  event: SessionEvent,
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
  const initial = initialSessionProjection();
  return {
    [SESSION_PROJECTION_STATE_KEY]: {
      ...initial,
      view: {
        ...initial.view,
        session: { status: "open", turnCount: position.sequence },
      },
    } satisfies SessionProjection,
  };
}

/** The session holding `input` until it can run. */
export function withQueuedInput<T extends Pick<HarnessSession, "state">>(
  session: T,
  input: HarnessStepInput,
): T {
  return writeTurnState(session, { ...readTurnState(session.state), queued: input });
}

export function parkedSteps(session: Pick<HarnessSession, "state">): readonly SuspendedStep[] {
  return suspendedSteps(session.state);
}

export function positionOf(session: Pick<HarnessSession, "state">): TurnPosition {
  return turnPosition(storedProjection(session.state));
}

/** `session` relaying requests for a child, as the session machine records them. */
export function withRelays<T extends { readonly state?: SessionStateMap }>(
  session: T,
  upsert: NonNullable<RelayChange["upsert"]>,
): T {
  return writeHitlState(session, { relays: { upsert } });
}

/** The public tables `events` fold into, each event its own line, as a reader receives them. */
export function tablesOf(events: readonly SessionEvent[]): PublicSessionView {
  return viewOfEvents(
    events.map((event, line) => ({
      ...event,
      meta: { at: "2026-10-09T00:00:00.000Z", endOfLine: true, position: { index: 0, line } },
    })),
  ).view;
}
