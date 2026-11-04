import {
  delegatedUsageFact,
  fact,
  runRequested,
  runSettledFacts,
  runStarted,
  type RunSettlement,
} from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ErrorInfo, Usage } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { ModelOwner } from "#protocol/session-events/families/model.js";
import { transition, type Transition } from "./commit.js";
import { commitOf } from "./commit.js";
import type { SessionView } from "./view.js";

// The run family's commits: a model run asked for, started, retried, and settled with what it
// spent, and spend recorded apart from a run. The step decides when; the kernel builds them.

/** A model run is asked for: a turn's, or a context change's summary run. */
export function requestRun(owner: ModelOwner, runId: string): Commit {
  return commitOf([runRequested(owner, runId)]);
}

/** The run's model was chosen and an attempt at its provider call begins. */
export function startRun(input: Parameters<typeof runStarted>[0]): Commit {
  return commitOf([runStarted(input)]);
}

/** An attempt failed and the run tries again. */
export function retryRun(input: {
  readonly attempt: number;
  readonly error: ErrorInfo;
  readonly runId: string;
}): Commit {
  return commitOf([fact("model.retried", input)]);
}

/** A run settles, with the result part it completed with, if any, and then what it spent. */
export function settleRun(
  settlement: RunSettlement,
  result?: FactOf<"content.completed">["data"],
): Commit {
  return commitOf([
    ...(result === undefined ? [] : [fact("content.completed", result)]),
    ...runSettledFacts(settlement),
  ]);
}

/** What a model call made outside eve's own model steps spent: inside a tool, against its call. */
export function recordUsage(input: {
  readonly kind: "auxiliary" | "decision";
  readonly callId?: string;
  readonly usage: Usage;
}): Commit {
  return commitOf([
    fact("usage.recorded", {
      kind: input.kind,
      ...(input.callId !== undefined && { owner: { callId: input.callId } }),
      usage: input.usage,
    }),
  ]);
}

/** Delegated spend that arrived after its calls settled, which no open entity owns. */
export function recordLateSpend(spends: readonly Usage[]): Commit {
  return commitOf(spends.map((spend) => delegatedUsageFact(undefined, spend)));
}

/**
 * Delegated spend, owned by the call this commit settles. One reply may settle several calls
 * with the same result; its spend belongs once to the latest served call (the message's
 * source), never once per recipient. A serve body can keep spending after it replied or while
 * cancellation unwinds: no open call owns that, and an immutable settlement can't be amended,
 * so it is the task's own `delegated-late` usage.
 */
export function taskSpend(
  view: SessionView,
  input: {
    readonly settling: readonly SessionEvent[];
    readonly sourceCallId: string | undefined;
    readonly spend: Usage;
    readonly taskId: string;
  },
): Transition {
  const settled = input.settling.filter((event) => event.type === "call.settled");
  const call = settled.find((event) => event.data.callId === input.sourceCallId) ?? settled[0];
  const event =
    call === undefined
      ? { ...delegatedUsageFact(undefined, input.spend), scope: { taskId: input.taskId } }
      : delegatedUsageFact(call.data.callId, input.spend);
  return transition({ events: [event], turn: view.turn });
}

/** Spend a task run reported once nothing it served was open: the task's own late spend. */
export function lateTaskSpend(view: SessionView, spend: Usage | undefined): Transition {
  return transition({
    events: spend === undefined ? [] : [delegatedUsageFact(undefined, spend)],
    turn: view.turn,
  });
}
