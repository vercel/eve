// v26 event builders for tests of the code that observes v26 events: built-in channels and
// authored hooks. Sessions never build these; `execution/legacy-events.ts` translates facts.

import type { ContextReader } from "#context/key.js";
import {
  ensureSessionProjection,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import { eventsOfLine } from "#protocol/session-lines.js";
import type { RuntimeActionRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type {
  ActionPresentationByCallId,
  ActionsRequestedStreamEvent,
  InputResolution,
  InputRequestedStreamEvent,
  InputResolvedStreamEvent,
  TaskSettledStreamEvent,
  TaskStartedStreamEvent,
  TurnCompletedStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";

/**
 * Creates the `actions.requested` event for one observed group of model action
 * requests.
 */
export function createActionsRequestedEvent(input: {
  readonly actions: readonly RuntimeActionRequest[];
  readonly presentation?: ActionPresentationByCallId;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): ActionsRequestedStreamEvent {
  return {
    data: {
      actions: input.actions,
      ...optionalPresentation(input.presentation),
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "actions.requested",
  };
}

/**
 * Creates the `input.requested` event for one pending HITL batch.
 */
export function createInputRequestedEvent(input: {
  readonly callId?: string;
  readonly requests: readonly InputRequest[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly taskId?: string;
  readonly turnId: string;
}): InputRequestedStreamEvent {
  const data: InputRequestedStreamEvent["data"] = {
    requests: input.requests,
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  };
  if (input.callId !== undefined) data.callId = input.callId;
  if (input.taskId !== undefined) data.taskId = input.taskId;
  return { data, type: "input.requested" };
}

/** Creates the authoritative `input.resolved` event for one pending HITL batch. */
export function createInputResolvedEvent(input: {
  readonly resolutions: readonly InputResolution[];
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}): InputResolvedStreamEvent {
  return {
    data: {
      resolutions: input.resolutions,
      sequence: input.sequence,
      stepIndex: input.stepIndex,
      turnId: input.turnId,
    },
    type: "input.resolved",
  };
}

/** Creates the `task.settled` event for one settled task call. */
export function createTaskSettledEvent(
  input: TaskSettledStreamEvent["data"],
): TaskSettledStreamEvent {
  const data: TaskSettledStreamEvent["data"] = {
    callId: input.callId,
    status: input.status,
    taskId: input.taskId,
    turnId: input.turnId,
  };
  if (input.kind !== undefined) data.kind = input.kind;
  if (input.name !== undefined) data.name = input.name;
  if (input.output !== undefined) data.output = input.output;
  if (input.error !== undefined) data.error = input.error;
  if (input.cancel !== undefined) data.cancel = input.cancel;
  return { data, type: "task.settled" };
}

/** Creates the `task.started` event for one call that starts a task. */
export function createTaskStartedEvent(
  input: TaskStartedStreamEvent["data"],
): TaskStartedStreamEvent {
  return {
    data: {
      callId: input.callId,
      kind: input.kind,
      name: input.name,
      taskId: input.taskId,
      turnId: input.turnId,
    },
    type: "task.started",
  };
}

/**
 * Creates the `turn.completed` event for one terminal successful turn.
 */
export function createTurnCompletedEvent(input: {
  readonly sequence: number;
  readonly turnId: string;
}): TurnCompletedStreamEvent {
  return {
    data: {
      sequence: input.sequence,
      turnId: input.turnId,
    },
    type: "turn.completed",
  };
}

function optionalPresentation(presentation: ActionPresentationByCallId | undefined): {
  readonly presentation?: ActionPresentationByCallId;
} {
  return presentation === undefined ? {} : { presentation };
}

/**
 * Records, for a test that drives a channel with v26 events, the facts the session would have
 * written for them: the requests an `input.requested` opened, and how `input.resolved` or
 * `approval.settled` settled them. The session records each line before its channel handlers
 * run, so call this before the handler. Other events change nothing a channel reads.
 */
export function recordLegacyEvent(ctx: ContextReader, event: UnstampedMessageStreamEvent): void {
  const facts = factsOfLegacyEvent(event);
  if (facts.length === 0) return;
  ensureSessionProjection(ctx, undefined);
  const line = { at: new Date().toISOString(), facts };
  const position = nextLinePosition(ctx);
  recordPublishedLine(ctx, line, position, eventsOfLine(line, position, line.at));
}

function factsOfLegacyEvent(event: UnstampedMessageStreamEvent): SessionEvent[] {
  switch (event.type) {
    case "input.requested":
      return event.data.requests.map((request) => {
        const kind =
          request.kind === "tool-approval"
            ? "approval"
            : request.kind === "session-limit"
              ? "budget"
              : "question";
        const opened: Mutable<FactOf<"interaction.opened">["data"]["request"]> = {
          kind,
          prompt: request.prompt,
        };
        if (request.options !== undefined) opened.options = request.options;
        if (request.display !== undefined) opened.display = request.display;
        if (request.allowFreeform !== undefined) opened.allowFreeform = request.allowFreeform;
        return {
          data: {
            interactionId: request.requestId,
            request: opened,
            subject:
              kind === "approval"
                ? { callId: request.action.callId }
                : { turnId: event.data.turnId },
          },
          type: "interaction.opened",
        } satisfies FactOf<"interaction.opened">;
      });
    case "input.resolved":
      return event.data.resolutions.map((resolution) => ({
        data: {
          interactionId: resolution.requestId,
          outcome:
            resolution.outcome === "approved" || resolution.outcome === "answered"
              ? "accepted"
              : resolution.outcome === "denied"
                ? "declined"
                : resolution.outcome === "invalid"
                  ? "invalid"
                  : "withdrawn",
        },
        type: "interaction.settled",
      }));
    case "approval.settled":
      return [
        {
          data: {
            interactionId: event.data.requestId,
            outcome: event.data.outcome === "approved" ? "accepted" : "declined",
          },
          type: "interaction.settled",
        },
      ];
    default:
      return [];
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
