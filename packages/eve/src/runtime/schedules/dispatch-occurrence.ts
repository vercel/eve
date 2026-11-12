import { createHash, randomUUID } from "node:crypto";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleOccurrenceIdentity,
  ScheduleScopeValue,
} from "#public/schedules/subscription.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

type ScheduleDispatchBundle = Pick<CompiledRuntimeAgentBundle, "compiledArtifactsSource" | "graph">;

/** Dispatches an at-least-once callback and reports the sessions it started, if any. */
export async function dispatchScheduledOccurrence(input: {
  readonly bundle: ScheduleDispatchBundle;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly payload: ScheduleCollectionPayload<unknown>;
  /** The namespace a provider delivered the occurrence from, after `verifyDelivery` checks it. */
  readonly namespace?: string;
  readonly verifyDelivery?: () => Promise<void>;
}): Promise<void> {
  const occurrence = {
    ...input.occurrence,
    displayName: scheduleDisplayName(input.occurrence.name),
  };
  const { provider } = input.definition;
  // The delivered namespace, or else the stored scope, names where this schedule lives. No
  // caller is present to authorize, and the callback only reaches the schedule that fired it.
  const providerContext = () =>
    createScheduleProviderContext({
      abortSignal: new AbortController().signal,
      application: input.payload.eve.application,
      bundle: () => input.bundle,
      collection: input.collection,
      definition: input.definition,
      namespace: input.namespace,
      operationId: randomUUID(),
      scope: input.payload.envelope.scope,
    });
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
    schedule: {
      async disable() {
        await provider.disable(providerContext(), occurrence.name);
      },
      async delete() {
        await provider.delete(providerContext(), occurrence.name);
      },
    },
    verifyDelivery: input.verifyDelivery,
  });
  await input.definition.events?.["occurrence.dispatched"]?.({
    collection: input.collection,
    executionId: input.occurrence.executionId,
    name: occurrence.name,
    occurrence,
    scheduledAt: input.occurrence.scheduledAt,
    scheduleId: input.occurrence.scheduleId,
    sessionIds: result.sessions.map((session) => session.sessionId),
    schedule: input.payload.envelope,
    type: "occurrence.dispatched",
  });
}

/** Addresses one provider operation to a scope's namespace; its target dispatches occurrences the provider delivers in process. */
export function createScheduleProviderContext(input: {
  readonly abortSignal: AbortSignal;
  readonly application: string;
  readonly bundle: () => ScheduleDispatchBundle;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  /** Overrides the namespace derived from `scope`, for a schedule whose namespace is already known. */
  readonly namespace?: string;
  readonly operationId: string;
  readonly scope: ScheduleScopeValue;
}): ScheduleProviderContext {
  return {
    abortSignal: input.abortSignal,
    collection: input.collection,
    namespace:
      input.namespace ?? deriveScheduleNamespace(input.application, input.collection, input.scope),
    operationId: input.operationId,
    target: {
      key: input.application,
      deliver: async ({ payload, occurrence }) => {
        await dispatchScheduledOccurrence({
          bundle: input.bundle(),
          collection: input.collection,
          definition: input.definition,
          occurrence: { ...occurrence, collection: input.collection },
          payload: payload as ScheduleCollectionPayload<unknown>,
        });
      },
    },
  };
}

function deriveScheduleNamespace(
  application: string,
  collection: string,
  scope: ScheduleScopeValue,
): string {
  if (application.trim().length === 0) throw new Error("Schedule application must not be empty.");
  const digest = createHash("sha256")
    .update(JSON.stringify(["eve-schedule-namespace-v2", application, collection, scope]))
    .digest("base64url");
  return `eve-${digest}`;
}
