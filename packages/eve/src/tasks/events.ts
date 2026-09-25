import {
  createTaskEndedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  type TaskEndedStreamEvent,
  type TaskSettledStreamEvent,
  type TaskStartedStreamEvent,
} from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { TaskOutcome } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import type { TaskEffect } from "#tasks/table.js";

// Project task lifecycle onto the owner's session stream. Both agent and
// workflow tasks use these, so consumers read one event family. The table
// orders the lifecycle effects; this module only renders them.

export type TaskLifecycleStreamEvent =
  | TaskStartedStreamEvent
  | TaskSettledStreamEvent
  | TaskEndedStreamEvent;

/** A transition's lifecycle events, in the order its effects list them. */
export function taskEvents(
  effects: readonly TaskEffect[],
  ownerSessionId: string,
): TaskLifecycleStreamEvent[] {
  return effects.flatMap((effect): TaskLifecycleStreamEvent[] => {
    switch (effect.kind) {
      case "started":
        return [taskStartedEvent(effect.record, ownerSessionId)];
      case "settled":
        return [taskSettledEvent(effect.record, effect.outcome, effect.usage)];
      case "cancelled":
        return [taskSettledEvent(effect.record, { status: "cancelled" })];
      case "ended":
        return [createTaskEndedEvent(effect.record.id)];
      default:
        return [];
    }
  });
}

function taskStartedEvent(record: TaskRecord, ownerSessionId: string): TaskStartedStreamEvent {
  const { child } = record;
  return createTaskStartedEvent({
    callId: record.callId,
    child:
      child?.kind === "local"
        ? { sessionId: child.sessionId }
        : child?.kind === "remote"
          ? {
              remote: { resolverId: child.credentialResolver ?? record.nodeId, url: child.url },
              sessionId: child.sessionId,
            }
          : // A workflow run has no session stream to follow, and an unstarted child none yet.
            undefined,
    generation: record.generation,
    kind: record.kind,
    mode: record.mode,
    name: record.name,
    parentSessionId: ownerSessionId,
    resumable: record.resumable === true,
    taskId: record.id,
    turnId: record.turnId,
  });
}

function taskSettledEvent(
  record: TaskRecord,
  outcome: TaskOutcome,
  usage?: TokenUsage,
): TaskSettledStreamEvent {
  const identity = {
    callId: record.callId,
    generation: record.generation,
    taskId: record.id,
    usage,
  };
  switch (outcome.status) {
    case "completed":
      return createTaskSettledEvent({ ...identity, output: outcome.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({ ...identity, error: outcome.error, status: "failed" });
    case "cancelled":
      return createTaskSettledEvent({ ...identity, status: "cancelled" });
  }
}
