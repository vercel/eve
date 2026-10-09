import type { SessionAuthContext } from "#channel/types.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { ModelMessage } from "ai";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import {
  initialSessionProjection,
  openRunOf,
  turnCoordinates,
  type SessionProjection,
} from "#protocol/session-projection.js";
import {
  readTurnState,
  type StepCoordinates,
  type SuspendedStep,
  type TurnState,
} from "./state.js";

// What the session machine reads, and the read-only selectors the rest of eve uses. Lifecycle
// comes from the stored projection, which publishing folds from every event the session
// publishes; execution comes from `TurnState`. Workflow bodies import this module, so it stays
// free of runtime dependencies; a step reads the live projection through `current.ts`.

export type { StepCoordinates, SuspendedStep, TurnState } from "./state.js";

export const SESSION_PROJECTION_STATE_KEY = "eve.harness.sessionProjection";

/** What a transition sees. */
export interface SessionView {
  readonly turn: TurnState;
  readonly projection: SessionProjection;
  /** Requests this session relays for a child session or a workflow run, by `requestId`. */
  readonly relayedRequestIds: ReadonlySet<string>;
  /** The sign-in attempts the session waits on, with what completing them needs. */
  readonly signIns: readonly AuthorizationChallenge[];
  /** The session's token usage so far, which its waiting and terminal events report. */
  readonly usage: TokenUsage;
}

/** Reads the authoritative lifecycle facts saved alongside execution state. */
export function storedProjection(state: SessionStateMap | undefined): SessionProjection {
  return (
    (state?.[SESSION_PROJECTION_STATE_KEY] as SessionProjection | undefined) ??
    initialSessionProjection()
  );
}

/** Coordinates the next lifecycle event carries, and whether a turn is open. */
export interface TurnPosition {
  readonly sessionStarted: boolean;
  readonly sequence: number;
  readonly stepIndex: number;
  /** The open turn's id, or `""` between turns. */
  readonly turnId: string;
  /** The open turn streamed assistant output, so steering can no longer restart it. */
  readonly assistantOutputStarted?: boolean;
  /** The open turn's latest open model run, which content and calls belong to. */
  readonly runId?: string;
}

export function turnPosition(projection: SessionProjection): TurnPosition {
  const { sequence, stepIndex } = turnCoordinates(projection);
  const turn =
    projection.activeTurnId === undefined ? undefined : projection.turns[projection.activeTurnId];
  const position: { -readonly [K in keyof TurnPosition]: TurnPosition[K] } = {
    sessionStarted: projection.started === true,
    sequence,
    stepIndex,
    turnId: turn?.turnId ?? "",
  };
  if (turn?.outputStarted === true) position.assistantOutputStarted = true;
  const runId = turn === undefined ? undefined : openRunOf(projection, turn.turnId);
  if (runId !== undefined) position.runId = runId;
  return position;
}

/** The open turn's id, or the id the next turn takes. */
export function activeTurnId(position: Pick<TurnPosition, "sequence" | "turnId">): string {
  return position.turnId === "" ? `turn_${position.sequence}` : position.turnId;
}

export function isBetweenTurns(projection: SessionProjection): boolean {
  return projection.activeTurnId === undefined;
}

/** The index the open turn's next `step.started` takes. */
export function nextStepIndex(projection: SessionProjection): number {
  const turn =
    projection.activeTurnId === undefined ? undefined : projection.turns[projection.activeTurnId];
  return turn?.stepIndex === undefined ? 0 : turn.stepIndex + 1;
}

/** Input the session holds until it can run. */
export function queuedInput(state: SessionStateMap | undefined): StepInput | undefined {
  return readTurnState(state).queued;
}

export function suspendedSteps(state: SessionStateMap | undefined): readonly SuspendedStep[] {
  return readTurnState(state).suspended;
}

/** The ids of calls that already have a result in `messages`. */
export function answeredCallIds(messages: readonly ModelMessage[]): ReadonlySet<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "assistant") continue;
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return answered;
}

/** Workflow and agent calls of `step` the runtime still runs. */
export function runningTasks(step: SuspendedStep): readonly RuntimeWorkflowTaskRequest[] {
  const answered = answeredCallIds(step.messages);
  return step.tasks.filter((task) => !answered.has(task.callId));
}

/** What the turn waits on the runtime for: dispatched runs and the task tool calls. */
export interface RuntimeWait {
  readonly event: StepCoordinates;
  readonly callIds: readonly string[];
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly taskToolCalls: readonly TaskToolCall[];
  /** Who approved each task an approval started, by call id. */
  readonly approvers: Readonly<Record<string, SessionAuthContext>>;
}

/** The calls suspended steps wait on the runtime for, or `undefined` when none do. */
export function runtimeWait(state: SessionStateMap | undefined): RuntimeWait | undefined {
  const waiting = suspendedSteps(state).flatMap((step) => {
    const tasks = runningTasks(step);
    const taskToolCalls = pendingTaskToolCalls(step.messages);
    return tasks.length === 0 && taskToolCalls.length === 0 ? [] : [{ step, tasks, taskToolCalls }];
  });
  const first = waiting[0];
  if (first === undefined) return undefined;
  const tasks = waiting.flatMap((entry) => entry.tasks);
  const taskToolCalls = waiting.flatMap((entry) => entry.taskToolCalls);
  return {
    approvers: Object.assign({}, ...waiting.map((entry) => entry.step.approvers)),
    callIds: [...tasks.map((task) => task.callId), ...taskToolCalls.map((call) => call.callId)],
    event: first.step.event,
    taskToolCalls,
    tasks,
  };
}
