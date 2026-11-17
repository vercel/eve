import type { ModelMessage } from "ai";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { PendingResponder } from "#harness/hitl/index.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { SessionStateMap, HarnessStepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import {
  initialSessionProjection,
  activeTurnIdOf,
  openRunOf,
  turnCoordinates,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import { openRequests } from "#protocol/session-projection/reader.js";
import {
  readTurnState,
  type StepCoordinates,
  type SuspendedStep,
  type TurnState,
} from "./state.js";

export type {
  ApprovalAsk,
  ApprovedCall,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "./state.js";

export const SESSION_PROJECTION_STATE_KEY = "eve.harness.sessionProjection";

export interface SessionView {
  readonly turn: TurnState;
  readonly projection: SessionProjection;
  readonly relayedRequestIds: ReadonlySet<string>;
  readonly responders: Readonly<Record<string, PendingResponder>>;
  readonly signIns: readonly AuthorizationChallenge[];
}

export function storedProjection(state: SessionStateMap | undefined): SessionProjection {
  const stored = state?.[SESSION_PROJECTION_STATE_KEY] as Partial<SessionProjection> | undefined;
  if (stored === undefined) return initialSessionProjection();
  const initial = initialSessionProjection();
  const projection: SessionProjection = {
    counters: stored.counters ?? initial.counters,
    view: stored.view ?? initial.view,
    usageWindow: stored.usageWindow,
  };
  return stored.outputStarted === undefined
    ? projection
    : { ...projection, outputStarted: stored.outputStarted };
}

export interface TurnPosition {
  readonly sessionStarted: boolean;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly assistantOutputStarted?: boolean;
  readonly runId?: string;
}

export function turnPosition(projection: SessionProjection): TurnPosition {
  const { sequence, stepIndex } = turnCoordinates(projection);
  const turnId = activeTurnIdOf(projection);
  const position: { -readonly [K in keyof TurnPosition]: TurnPosition[K] } = {
    sessionStarted: projection.view.session.status !== "new",
    sequence,
    stepIndex,
    turnId: turnId ?? "",
  };
  if (turnId === undefined) return position;
  if (projection.outputStarted === turnId) position.assistantOutputStarted = true;
  const runId = openRunOf(projection, turnId);
  if (runId !== undefined) position.runId = runId;
  return position;
}

export function activeTurnId(position: Pick<TurnPosition, "sequence" | "turnId">): string {
  return position.turnId === "" ? `turn_${position.sequence}` : position.turnId;
}

export function isBetweenTurns(projection: SessionProjection): boolean {
  return activeTurnIdOf(projection) === undefined;
}

export function queuedInput(state: SessionStateMap | undefined): HarnessStepInput | undefined {
  return readTurnState(state).queued;
}

export function suspendedSteps(state: SessionStateMap | undefined): readonly SuspendedStep[] {
  return readTurnState(state).suspended;
}

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

export function runningTasks(step: SuspendedStep): readonly RuntimeWorkflowTaskRequest[] {
  const answered = answeredCallIds(step.messages);
  return step.tasks.filter((task) => !answered.has(task.callId));
}

export interface RuntimeWait {
  readonly event: StepCoordinates;
  readonly callIds: readonly string[];
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly taskToolCalls: readonly TaskToolCall[];
}

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
    callIds: [...tasks.map((task) => task.callId), ...taskToolCalls.map((call) => call.callId)],
    event: first.step.event,
    taskToolCalls,
    tasks,
  };
}

export function stepForRequest(
  view: SessionView,
  interactionId: string,
): SuspendedStep | undefined {
  return view.turn.suspended.find((step) =>
    step.requests.some((request) => request.interactionId === interactionId),
  );
}

export function ownOpenRequestIds(view: Omit<SessionView, "turn">): ReadonlySet<string> {
  return new Set(
    openRequests(view.projection.view)
      .filter(
        (row) =>
          row.origin === undefined &&
          interactionOwner(view.projection.view, row).taskId === undefined &&
          !view.relayedRequestIds.has(row.interactionId),
      )
      .map((row) => row.interactionId),
  );
}
