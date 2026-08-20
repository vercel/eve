import type {
  ActionResultStreamEvent,
  ActionsRequestedStreamEvent,
  AuthorizationCompletedStreamEvent,
  AuthorizationRequiredStreamEvent,
  InputRequestedStreamEvent,
  StepCompletedStreamEvent,
  StepFailedStreamEvent,
  StepStartedStreamEvent,
  SubagentCalledStreamEvent,
  TurnCancelledStreamEvent,
  TurnCompletedStreamEvent,
  TurnFailedStreamEvent,
  TurnStartedStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

export type WorkPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface WorkAction {
  readonly callId: string;
  readonly kind: RuntimeActionRequest["kind"];
  readonly name: string;
  readonly phase: WorkPhase;
  readonly detail?: string;
  readonly child?: {
    readonly sessionId: string;
    readonly work?: WorkGraph;
  };
}

export interface WorkStep {
  readonly phase: WorkPhase;
  readonly stepIndex: number;
  readonly actions: readonly WorkAction[];
}

export interface WorkBlocker {
  readonly id: string;
  readonly kind: "approval" | "authorization" | "input";
  readonly ownerCallId?: string;
  readonly phase: "blocked" | "cancelled" | "completed";
}

export interface WorkTurn {
  readonly id: string;
  readonly phase: WorkPhase;
  readonly steps: readonly WorkStep[];
  readonly blockers: readonly WorkBlocker[];
}

export interface WorkGraph {
  readonly revision: number;
  readonly turn?: WorkTurn;
}

export interface ChildWorkSnapshot {
  readonly callId: string;
  readonly sessionId: string;
  readonly snapshot: WorkGraph;
}

const EMPTY_WORK_GRAPH: WorkGraph = { revision: 0 };

/** Reduces authoritative stream lifecycle facts into the live work graph. */
export function reduceWorkGraph(
  graph: WorkGraph = EMPTY_WORK_GRAPH,
  event: UnstampedMessageStreamEvent,
): WorkGraph {
  const next = reduce(graph, event);
  return next === graph ? graph : { ...next, revision: graph.revision + 1 };
}

/** Adopts a newer snapshot from one direct running local subagent. */
export function adoptChildWorkSnapshot(graph: WorkGraph, child: ChildWorkSnapshot): WorkGraph {
  const turn = graph.turn;
  if (turn === undefined || isTerminal(turn.phase)) return graph;
  const stepIndex = turn.steps.findIndex((step) =>
    step.actions.some((action) => action.callId === child.callId),
  );
  if (stepIndex === -1) return graph;
  const step = turn.steps[stepIndex]!;
  let changed = false;
  const actions = step.actions.map((action) => {
    if (action.callId !== child.callId || isTerminal(action.phase)) return action;
    if (action.child?.sessionId !== child.sessionId) return action;
    if ((action.child.work?.revision ?? -1) >= child.snapshot.revision) return action;
    changed = true;
    return { ...action, child: { ...action.child, work: child.snapshot } };
  });
  if (!changed) return graph;
  const steps = [...turn.steps];
  steps[stepIndex] = { ...step, actions };
  return { ...graph, revision: graph.revision + 1, turn: { ...turn, steps } };
}

function reduce(graph: WorkGraph, event: UnstampedMessageStreamEvent): WorkGraph {
  switch (event.type) {
    case "turn.started":
      return startTurn(graph, event);
    case "step.started":
      return updateStep(graph, event, (step) => ({ ...step, phase: "running" }));
    case "step.completed":
      return updateStep(graph, event, (step) => ({ ...step, phase: "completed" }));
    case "step.failed":
      return updateStep(graph, event, (step) => ({ ...step, phase: "failed" }));
    case "actions.requested":
      return addActions(graph, event);
    case "action.result":
      return settleAction(graph, event);
    case "subagent.called":
      return attachChild(graph, event);
    case "input.requested":
      return addInputBlocker(graph, event);
    case "authorization.required":
      return addAuthorizationBlocker(graph, event);
    case "authorization.completed":
      return settleAuthorizationBlocker(graph, event);
    case "turn.completed":
      return settleTurn(graph, event, "completed");
    case "turn.failed":
      return settleTurn(graph, event, "failed");
    case "turn.cancelled":
      return settleTurn(graph, event, "cancelled");
    default:
      return graph;
  }
}

function startTurn(graph: WorkGraph, event: TurnStartedStreamEvent): WorkGraph {
  if (graph.turn?.id === event.data.turnId) return graph;
  return {
    ...graph,
    turn: {
      blockers: [],
      id: event.data.turnId,
      phase: "running",
      steps: [],
    },
  };
}

function updateStep(
  graph: WorkGraph,
  event:
    | ActionsRequestedStreamEvent
    | StepStartedStreamEvent
    | StepCompletedStreamEvent
    | StepFailedStreamEvent,
  update: (step: WorkStep) => WorkStep,
): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined) return graph;
  const index = turn.steps.findIndex((step) => step.stepIndex === event.data.stepIndex);
  const current: WorkStep =
    index === -1
      ? { actions: [], phase: "queued", stepIndex: event.data.stepIndex }
      : turn.steps[index]!;
  const next = update(current);
  if (next === current) return graph;
  const steps = [...turn.steps];
  if (index === -1) steps.push(next);
  else steps[index] = next;
  return replaceTurn(graph, {
    ...turn,
    steps: steps.sort((left, right) => left.stepIndex - right.stepIndex),
  });
}

function addActions(graph: WorkGraph, event: ActionsRequestedStreamEvent): WorkGraph {
  return updateStep(graph, event, (step) => {
    const existing = new Set(step.actions.map((action) => action.callId));
    const added = event.data.actions
      .filter((action) => !existing.has(action.callId))
      .map(toWorkAction);
    return added.length === 0
      ? step
      : { ...step, actions: [...step.actions, ...added], phase: "running" };
  });
}

function settleAction(graph: WorkGraph, event: ActionResultStreamEvent): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined) return graph;
  const phase: WorkPhase = event.data.status === "completed" ? "completed" : "failed";
  const stepIndex = turn.steps.findIndex((step) =>
    step.actions.some((action) => action.callId === event.data.result.callId),
  );
  if (stepIndex === -1) return graph;
  const step = turn.steps[stepIndex]!;
  let changed = false;
  const actions = step.actions.map((action) => {
    if (action.callId !== event.data.result.callId || isTerminal(action.phase)) return action;
    changed = true;
    return { ...action, phase };
  });
  if (!changed) return graph;
  const steps = [...turn.steps];
  steps[stepIndex] = { ...step, actions };
  return replaceTurn(graph, { ...turn, steps });
}

function attachChild(graph: WorkGraph, event: SubagentCalledStreamEvent): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined) return graph;
  const stepIndex = turn.steps.findIndex((step) =>
    step.actions.some((action) => action.callId === event.data.callId),
  );
  if (stepIndex === -1) return graph;
  const step = turn.steps[stepIndex]!;
  let changed = false;
  const actions = step.actions.map((action) => {
    if (action.callId !== event.data.callId || action.child !== undefined) return action;
    changed = true;
    return { ...action, child: { sessionId: event.data.childSessionId } };
  });
  if (!changed) return graph;
  const steps = [...turn.steps];
  steps[stepIndex] = { ...step, actions };
  return replaceTurn(graph, { ...turn, steps });
}

function addInputBlocker(graph: WorkGraph, event: InputRequestedStreamEvent): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined || event.data.requests.length === 0) return graph;
  const blockers = event.data.requests.map((request) => ({
    id: request.requestId,
    kind: "input" as const,
    phase: "blocked" as const,
  }));
  return replaceTurn(graph, {
    ...turn,
    blockers: mergeBlockers(turn.blockers, blockers),
    phase: "blocked",
  });
}

function addAuthorizationBlocker(
  graph: WorkGraph,
  event: AuthorizationRequiredStreamEvent,
): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined) return graph;
  const blocker: WorkBlocker = {
    id: `authorization:${event.data.name}`,
    kind: "authorization",
    phase: "blocked",
  };
  return replaceTurn(graph, {
    ...turn,
    blockers: mergeBlockers(turn.blockers, [blocker]),
    phase: "blocked",
  });
}

function settleAuthorizationBlocker(
  graph: WorkGraph,
  event: AuthorizationCompletedStreamEvent,
): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined) return graph;
  const id = `authorization:${event.data.name}`;
  const phase: WorkBlocker["phase"] =
    event.data.outcome === "authorized" ? "completed" : "cancelled";
  const blockers = turn.blockers.map((blocker) =>
    blocker.id === id && blocker.phase === "blocked" ? { ...blocker, phase } : blocker,
  );
  if (blockers === turn.blockers) return graph;
  return replaceTurn(graph, { ...turn, blockers, phase: "running" });
}

function settleTurn(
  graph: WorkGraph,
  event: TurnCompletedStreamEvent | TurnFailedStreamEvent | TurnCancelledStreamEvent,
  phase: "completed" | "failed" | "cancelled",
): WorkGraph {
  const turn = activeTurn(graph, event.data.turnId);
  if (turn === undefined || isTerminal(turn.phase)) return graph;
  return replaceTurn(graph, { ...turn, phase });
}

function toWorkAction(action: RuntimeActionRequest): WorkAction {
  switch (action.kind) {
    case "load-skill":
      return { callId: action.callId, kind: action.kind, name: "load_skill", phase: "running" };
    case "remote-agent-call":
      return {
        callId: action.callId,
        kind: action.kind,
        name: action.remoteAgentName,
        phase: "running",
      };
    case "subagent-call":
      return {
        callId: action.callId,
        kind: action.kind,
        name: action.subagentName,
        phase: "running",
      };
    case "tool-call":
      return {
        callId: action.callId,
        detail: typeof action.input.stage === "string" ? action.input.stage : undefined,
        kind: action.kind,
        name: action.toolName,
        phase: "running",
      };
  }
}

function activeTurn(graph: WorkGraph, id: string): WorkTurn | undefined {
  return graph.turn?.id === id && !isTerminal(graph.turn.phase) ? graph.turn : undefined;
}

function replaceTurn(graph: WorkGraph, turn: WorkTurn): WorkGraph {
  return graph.turn === turn ? graph : { ...graph, turn };
}

function mergeBlockers(
  existing: readonly WorkBlocker[],
  added: readonly WorkBlocker[],
): readonly WorkBlocker[] {
  const byId = new Map(existing.map((blocker) => [blocker.id, blocker]));
  for (const blocker of added) byId.set(blocker.id, blocker);
  const next = [...byId.values()];
  return sameBlockers(existing, next) ? existing : next;
}

function sameBlockers(left: readonly WorkBlocker[], right: readonly WorkBlocker[]): boolean {
  return left.length === right.length && left.every((blocker, index) => blocker === right[index]);
}

function isTerminal(phase: WorkPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}
