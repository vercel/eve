import { cascade } from "#harness/session-machine/cascade.js";
import { linesOf } from "#protocol/session-lines.js";
import { viewOfEvents } from "#protocol/session-projection/fold.js";
import type { SessionView as PublicSessionView } from "#protocol/session-projection/tables.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { activeTurnIdOf, latestTurnIdOf } from "#protocol/session-projection.js";
import type { ModelMessage } from "ai";

import { contextStorage } from "#context/container.js";
import { askApprovals } from "#harness/hitl/approvals.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { saveTransition, sessionView } from "#harness/session-machine/commit.js";
import { writeHitlState, type HitlStateChange } from "#harness/hitl/requests.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import { eventsOf } from "#harness/publication.js";
import {
  advance,
  checkFoldedLine,
  ensureSessionProjection,
  foldPublication,
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
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessStepInput,
  SessionStateMap,
} from "#harness/types.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk } from "#harness/session-machine/view.js";

export function withPublished(
  session: HarnessSession,
  events: readonly SessionEvent[],
): HarnessSession {
  let projection = storedProjection(session.state);
  for (const line of linesOf(cascade(projection.view, events), new Date().toISOString())) {
    const folded = "facts" in line ? line.facts : [line.progress];
    checkFoldedLine(projection.view, line, projection.view.position);
    projection = advance(projection, line, projection.view.position, folded);
  }
  return saveProjection(session, projection);
}

export function withOpenTurn(
  session: HarnessSession,
  position: { readonly sequence: number; readonly turnId: string; readonly stepIndex?: number },
): HarnessSession {
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
  return withPublished(saveTransition(opened, transition), transition.events);
}

export function foldingHandler(handleEvent?: TestEventHandler): HarnessEmitFn {
  return async (publication, messages) => {
    const ctx = contextStorage.getStore();
    if (ctx !== undefined) {
      ensureSessionProjection(ctx, undefined);
      foldPublication(ctx, publication);
    }
    if (handleEvent !== undefined) await eachEvent(handleEvent)(publication, messages);
  };
}

export type TestEventHandler = (
  event: SessionEvent,
  messages?: readonly ModelMessage[],
) => void | Promise<void>;

export function eachEvent(handler: TestEventHandler): HarnessEmitFn {
  return async (publication, messages) => {
    for (const event of eventsOf(publication)) await handler(event, messages);
  };
}

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

export function withRelays<T extends { readonly state?: SessionStateMap }>(
  session: T,
  relays: NonNullable<HitlStateChange["relays"]>,
): T {
  return writeHitlState(session, { relays });
}

export function tablesOf(events: readonly SessionEvent[]): PublicSessionView {
  return viewOfEvents(
    events.map((event, line) => ({
      ...event,
      meta: { at: "2026-10-09T00:00:00.000Z", endOfLine: true, position: { index: 0, line } },
    })),
  ).view;
}
