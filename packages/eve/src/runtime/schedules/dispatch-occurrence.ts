import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleOccurrenceIdentity,
} from "#public/schedules/subscription.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/** Dispatches an at-least-once callback and reports the sessions it started, if any. */
export async function dispatchScheduledOccurrence(input: {
  readonly bundle: Pick<CompiledRuntimeAgentBundle, "compiledArtifactsSource" | "graph">;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly payload: ScheduleCollectionPayload<unknown>;
  readonly verifyDelivery?: () => Promise<void>;
}): Promise<void> {
  const occurrence = {
    ...input.occurrence,
    displayName: scheduleDisplayName(input.occurrence.name),
  };
  const result = await new ScheduleDispatcher({
    runtime: createWorkflowRuntime({
      compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    }),
    channels: input.bundle.graph.root.channels,
  }).triggerCollection({
    collectionId: input.collection,
    definition: input.definition,
    occurrence,
    payload: input.payload,
    verifyDelivery: input.verifyDelivery,
  });
  await input.definition.events?.["occurrence.dispatched"]?.({
    collection: input.collection,
    executionId: input.occurrence.executionId,
    name: occurrence.name,
    occurrence,
    scheduledAt: input.occurrence.scheduledAt,
    scheduleId: input.occurrence.scheduleId,
    sessionIds: result.sessions.map((session) => session.id),
    schedule: input.payload.envelope,
    type: "occurrence.dispatched",
  });
}
