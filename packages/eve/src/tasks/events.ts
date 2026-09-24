import {
  createTaskSettledEvent,
  createTaskStartedEvent,
  type TaskSettledStreamEvent,
  type TaskStartedStreamEvent,
} from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { ChildAddress, TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import type { TaskEffect } from "#tasks/table.js";

// Project task lifecycle onto the owner's session stream. Both agent and
// workflow tasks use these, so consumers read one event family.

/** Announces the record's current generation once the owner knows its child. */
export function taskStartedEvent(input: {
  readonly child: ChildAddress;
  readonly ownerSessionId: string;
  readonly record: TaskRecord;
}): TaskStartedStreamEvent {
  const { child, record } = input;
  return createTaskStartedEvent({
    callId: record.callId,
    child:
      child.kind === "local"
        ? { sessionId: child.sessionId }
        : child.kind === "remote"
          ? {
              remote: { resolverId: child.credentialResolver ?? record.nodeId, url: child.url },
              sessionId: child.sessionId,
            }
          : // A workflow run has no session stream to follow.
            undefined,
    kind: record.kind,
    mode: record.mode,
    name: record.name,
    parentSessionId: input.ownerSessionId,
    taskId: record.id,
    turnId: record.turnId,
  });
}

/** Reports the first terminal outcome of the record's current generation. */
export function taskSettledEvent(input: {
  readonly outcome: TaskOutcome;
  readonly record: TaskRecord;
  readonly usage?: TokenUsage;
}): TaskSettledStreamEvent {
  const { outcome, record } = input;
  const identity = { callId: record.callId, taskId: record.id, usage: input.usage };
  switch (outcome.status) {
    case "completed":
      return createTaskSettledEvent({ ...identity, output: outcome.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({ ...identity, error: outcome.error, status: "failed" });
    case "cancelled":
      return createTaskSettledEvent({ ...identity, status: "cancelled" });
  }
}

/** One `task.settled` for each first terminal outcome among a transition's effects. */
export function settledEvents(effects: readonly TaskEffect[]): TaskSettledStreamEvent[] {
  return effects.flatMap((effect) =>
    effect.kind === "settled"
      ? [taskSettledEvent({ outcome: effect.outcome, record: effect.record, usage: effect.usage })]
      : [],
  );
}
