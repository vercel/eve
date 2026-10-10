import {
  failure,
  reply,
  viewOfEvents,
  type CallRow,
  type PartRow,
  type RunRow,
  type SessionPreviews,
  type SessionView,
  type TurnRow,
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
  const { view, previews } = viewOfEvents(events);
  return Object.values(view.turns)
    .sort((a, b) => a.introducedAt - b.introducedAt)
    .map((turn) => traceTurn(view, previews, turn, events));
}

function traceTurn(
  view: SessionView,
  previews: SessionPreviews,
  turn: TurnRow,
  events: readonly TranscriptStreamEvent[],
): TraceTurn {
  const runs = Object.values(view.runs)
    .filter((run) => "turnId" in run.owner && run.owner.turnId === turn.turnId)
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const steps = runs.map((run, stepIndex) => traceStep(view, previews, turn, run, stepIndex));
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
  previews: SessionPreviews,
  turn: TurnRow,
  run: RunRow,
  stepIndex: number,
): TraceStep {
  const parts = Object.values(view.parts)
    .filter((part) => part.runId === run.runId)
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const streaming = Object.values(previews.parts).filter((part) => part.runId === run.runId);
  const calls = Object.values(view.calls)
    .filter((call) => "runId" in call.owner && call.owner.runId === run.runId)
    .sort((a, b) => a.introducedAt - b.introducedAt);
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
  const subagentCount = Object.values(view.children).filter(
    (child) => "callId" in child.owner && callIds.has(child.owner.callId),
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

function traceAction(call: CallRow, turn: TurnRow): TraceAction {
  return {
    callId: call.callId,
    durationMs: durationBetween(call.startedAt, call.endedAt),
    endTime: call.endedAt,
    error:
      call.error === undefined ? undefined : { code: call.error.code, message: call.error.message },
    input: call.input,
    kind: actionKind(call.capability.kind),
    name: call.capability.name,
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

function actionStatus(call: CallRow, turn: TurnRow): TraceAction["status"] {
  if (call.status === "settled") {
    if (call.outcome === "completed") return "completed";
    if (call.outcome === "failed" || call.outcome === "rejected") return "failed";
    return "aborted";
  }
  if (turn.status === "settled") return "aborted";
  return call.status === "requested" ? "requested" : "running";
}

function stepStatus(run: RunRow, turn: TurnRow): TraceStep["status"] {
  if (run.status === "settled") {
    if (run.outcome === "completed") return "completed";
    if (run.outcome === "failed") return "failed";
    return "aborted";
  }
  return turn.status === "settled" ? "aborted" : "running";
}

function turnStatus(turn: TurnRow): TraceTurn["status"] {
  if (turn.status !== "settled") return "running";
  return turn.outcome === "failed" ? "failed" : "completed";
}

function textOf(parts: readonly PartRow[]): string {
  return parts
    .flatMap((part) => (typeof part.value === "string" ? [part.value] : []))
    .join("");
}

function userMessageOf(view: SessionView, turnId: string): string | undefined {
  const text = Object.values(view.deliveries)
    .filter((delivery) => delivery.turnId === turnId)
    .sort((a, b) => a.introducedAt - b.introducedAt)
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
