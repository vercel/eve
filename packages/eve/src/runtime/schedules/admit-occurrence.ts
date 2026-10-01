import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Session } from "#channel/session.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleOccurrenceIdentity,
} from "#public/schedules/collection.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

type DispatchInput = Parameters<ScheduleDispatcher["triggerCollection"]>[0];

/**
 * Admits one delivered occurrence to its session and reports
 * `occurrence.admitted`. Providers report `occurrence.failed` themselves: only
 * they know whether a failed attempt will be redelivered.
 */
export async function admitScheduledOccurrence(input: {
  readonly bundle: Pick<CompiledRuntimeAgentBundle, "compiledArtifactsSource" | "graph">;
  readonly collection: string;
  readonly definition: ScheduleCollectionDefinition<any, any>;
  readonly namespace: string;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly payload: ScheduleCollectionPayload<unknown, unknown>;
  readonly verifyNewAdmission?: () => Promise<void>;
}): Promise<Session> {
  const { definition, occurrence } = input;
  const dispatch: { -readonly [K in keyof DispatchInput]: DispatchInput[K] } = {
    collectionId: input.collection,
    definition,
    namespace: input.namespace,
    occurrence,
    payload: input.payload,
    scheduleName: occurrence.name,
  };
  if (input.verifyNewAdmission !== undefined)
    dispatch.verifyNewAdmission = input.verifyNewAdmission;
  const result = await new ScheduleDispatcher({
    runtime: createWorkflowRuntime({
      compiledArtifactsSource: input.bundle.compiledArtifactsSource,
      occurrenceAdmission: true,
    }),
    channels: input.bundle.graph.root.channels,
  }).triggerCollection(dispatch);
  const session = result.sessions[0];
  if (session === undefined) throw new Error("Scheduled occurrence was not admitted to a session.");
  await definition.events?.["occurrence.admitted"]?.({
    collection: input.collection,
    executionId: occurrence.executionId,
    name: occurrence.name,
    occurrence,
    scheduledAt: occurrence.scheduledAt,
    scheduleId: occurrence.scheduleId,
    sessionId: session.id,
    schedule: input.payload.envelope,
    type: "occurrence.admitted",
  });
  return session;
}
