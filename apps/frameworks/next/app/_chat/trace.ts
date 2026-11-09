import {
  failure,
  reply,
  emptySessionView,
  turns,
  runs as modelRuns,
  parts as contentParts,
  calls as observedCalls,
  deliveries,
  children,
  contentPreviews,
  foldEvents,
  type CallObservation,
  type ContentObservation,
  type RunObservation,
  type SessionView,
  type TurnObservation,
} from "eve/events";

import type {
  TraceAction,
  TraceActionKind,
  TraceStep,
  TraceTurn,
  TranscriptStreamEvent,
} from "./types";

/**
 * Reconstructs the shared turn model from the persisted session transcript.
 *
 * The transcript folds into eve's shared session tables, the same ones the server and every
 * channel read. Each model run of a turn is one trace step, each call a run made is one of its
 * actions, and durations come from the times of the lines that started and ended them.
 */
export function buildTraceTurnsFromTranscript(
  events: readonly TranscriptStreamEvent[],
): readonly TraceTurn[] {
  const view = foldEvents(emptySessionView(), events);
  return turns(view).map((turn) => traceTurn(view, turn, events));
}

function traceTurn(
  view: SessionView,
  turn: TurnObservation,
  events: readonly TranscriptStreamEvent[],
): TraceTurn {
  const runs = modelRuns(view, { turnId: turn.turnId });
  const steps = runs.map((run, stepIndex) => traceStep(view, turn, run, stepIndex));
  const answer = textOf(reply(view, turn.turnId));
  const failureMessage = failure(view, turn.turnId)?.message;
  return {
    assistantMessage: answer.length > 0 ? answer : undefined,
    durationMs: durationBetween(turn.startedAt, turn.endedAt),
    endTime: turn.endedAt,
    events: events.filter((event) => scopeTurnId(event) === turn.turnId),
    failureMessage,
    sequence: turnSequence(turn.turnId),
    startTime: turn.startedAt,
    status: turnStatus(turn),
    steps,
    subagentCount: steps.reduce((count, step) => count + step.subagentCount, 0),
    turnId: turn.turnId,
    userMessage: userMessageOf(view, turn.turnId),
  };
}

function traceStep(
  view: SessionView,
  turn: TurnObservation,
  run: RunObservation,
  stepIndex: number,
): TraceStep {
  const parts = contentParts(view, { runId: run.runId });
  const streaming = contentPreviews(view, { runId: run.runId });
  const calls = observedCalls(view, { runId: run.runId });
  const actions = calls.map((call) => traceAction(call, turn));
  const response =
    textOf(parts.filter((part) => part.kind === "text")) ||
    streaming
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("");
  const reasoning =
    textOf(parts.filter((part) => part.kind === "reasoning")) ||
    streaming
      .filter((part) => part.kind === "reasoning")
      .map((part) => part.text)
      .join("");
  const callIds = new Set(calls.map((call) => call.callId));
  const subagentCount = children(view).filter(
    (child) => child.callId !== undefined && callIds.has(child.callId),
  ).length;
  return {
    actionCount: actions.length,
    actions,
    durationMs: durationBetween(run.startedAt, run.endedAt),
    endTime: run.endedAt,
    errorMessage: run.error?.message,
    events: [],
    finishReason: run.finishReason,
    reasoningText: reasoning.length > 0 ? reasoning : undefined,
    responseText: response.length > 0 ? response : undefined,
    startTime: run.startedAt,
    status: stepStatus(run, turn),
    stepIndex,
    subagentCount,
    usage: run.usage,
  };
}

function traceAction(call: CallObservation, turn: TurnObservation): TraceAction {
  return {
    callId: call.callId,
    durationMs: durationBetween(call.startedAt, call.endedAt),
    endTime: call.endedAt,
    error:
      call.error === undefined ? undefined : { code: call.error.code, message: call.error.message },
    input: call.input,
    kind: actionKind(call.kind),
    name: call.name,
    output: call.output,
    startTime: call.startedAt,
    status: actionStatus(call, turn),
  };
}

function actionKind(kind: string): TraceActionKind {
  switch (kind) {
    case "tool":
      return "tool-call";
    case "skill":
      return "load-skill";
    case "agent":
      return "subagent-call";
    default:
      return "unknown";
  }
}

function actionStatus(call: CallObservation, turn: TurnObservation): TraceAction["status"] {
  if (call.state === "completed") return "completed";
  if (call.state === "failed" || call.state === "rejected") return "failed";
  if (call.state === "cancelled" || turn.status === "settled") return "aborted";
  return call.state === "requested" || call.state === "approval" ? "requested" : "running";
}

function stepStatus(run: RunObservation, turn: TurnObservation): TraceStep["status"] {
  if (run.status === "settled") {
    if (run.outcome === "completed") return "completed";
    if (run.outcome === "failed") return "failed";
    return "aborted";
  }
  return turn.status === "settled" ? "aborted" : "running";
}

function turnStatus(turn: TurnObservation): TraceTurn["status"] {
  if (turn.status !== "settled") return "running";
  return turn.outcome === "failed" ? "failed" : "completed";
}

function textOf(parts: readonly ContentObservation[]): string {
  return parts.flatMap((part) => (typeof part.value === "string" ? [part.value] : [])).join("");
}

function userMessageOf(view: SessionView, turnId: string): string | undefined {
  const text = deliveries(view, { turnId })
    .flatMap((delivery) => delivery.parts ?? [])
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function scopeTurnId(event: TranscriptStreamEvent): string | undefined {
  const scope = "scope" in event ? event.scope : undefined;
  if (typeof scope === "object" && scope !== null && "turnId" in scope) {
    return typeof scope.turnId === "string" ? scope.turnId : undefined;
  }
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "turnId" in data) {
    return typeof data.turnId === "string" ? data.turnId : undefined;
  }
  return undefined;
}

function turnSequence(turnId: string): number | undefined {
  const match = /^turn_(\d+)$/.exec(turnId);
  return match === null ? undefined : Number(match[1]);
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs
    ? undefined
    : endMs - startMs;
}
