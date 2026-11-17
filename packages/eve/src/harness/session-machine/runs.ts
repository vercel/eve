import {
  delegatedUsageFact,
  fact,
  runRequested,
  runSettledFacts,
  runStarted,
  type RunSettlement,
  runUsageRecorded,
} from "#harness/facts.js";
import type { Commit } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { ErrorInfo, Usage } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { ModelOwner } from "#protocol/session-events/families/model.js";
import { transition, type Transition } from "./commit.js";
import { commitOf } from "./commit.js";
import type { SessionView } from "./view.js";

export function requestRun(owner: ModelOwner, runId: string): Commit {
  return commitOf([runRequested(owner, runId)]);
}

export function startRun(input: Parameters<typeof runStarted>[0]): Commit {
  return commitOf([runStarted(input)]);
}

export function retryRun(input: {
  readonly attempt: number;
  readonly error: ErrorInfo;
  readonly runId: string;
  readonly usage?: Usage;
}): Commit {
  const { usage, ...retried } = input;
  return commitOf([
    fact("model.retried", retried),
    ...(usage === undefined ? [] : [runUsageRecorded(input.runId, usage)]),
  ]);
}

export function settleRun(
  settlement: RunSettlement,
  result?: FactOf<"content.completed">["data"],
): Commit {
  return commitOf([
    ...(result === undefined ? [] : [fact("content.completed", result)]),
    ...runSettledFacts(settlement),
  ]);
}

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

export function recordLateSpend(spends: readonly Usage[]): Commit {
  return commitOf(spends.map((spend) => delegatedUsageFact(undefined, spend)));
}

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

export function lateTaskSpend(view: SessionView, spend: Usage | undefined): Transition {
  return transition({
    events: spend === undefined ? [] : [delegatedUsageFact(undefined, spend)],
    turn: view.turn,
  });
}
