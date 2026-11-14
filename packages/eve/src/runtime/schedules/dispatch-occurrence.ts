import { createHash, randomUUID } from "node:crypto";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime } from "#channel/types.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleHandle,
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
  /** The runtime the occurrence's sessions start in: the host's. */
  readonly runtime: Runtime;
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
  const { application } = input.payload.eve;
  // The delivered namespace, or else the stored scope, identifies where this schedule lives. No
  // caller is present to authorize, and the callback only reaches the schedule that fired it.
  const namespace =
    input.namespace ??
    deriveScheduleNamespace(application, input.collection, input.payload.envelope.scope);
  const result = await new ScheduleDispatcher({
    runtime: input.runtime,
    channels: input.bundle.graph.root.channels,
  }).triggerCollection({
    collectionId: input.collection,
    definition: input.definition,
    namespace,
    occurrence,
    payload: input.payload,
    schedule: scheduleHandle({
      application,
      bundle: input.bundle,
      collection: input.collection,
      definition: input.definition,
      name: occurrence.name,
      namespace,
      runtime: input.runtime,
    }),
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

/** Disables or deletes one schedule at its provider namespace, without calling `scope`. */
export function scheduleHandle(input: {
  readonly application: string;
  readonly bundle: ScheduleDispatchBundle;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly name: string;
  readonly namespace: string;
  readonly runtime: Runtime;
}): ScheduleHandle {
  const providerContext = () =>
    createScheduleProviderContext({
      abortSignal: new AbortController().signal,
      application: input.application,
      bundle: () => input.bundle,
      collection: input.collection,
      definition: input.definition,
      namespace: input.namespace,
      operationId: randomUUID(),
      runtime: () => input.runtime,
    });
  return {
    async disable() {
      await input.definition.provider.disable(providerContext(), input.name);
    },
    async delete() {
      await input.definition.provider.delete(providerContext(), input.name);
    },
  };
}

/** Addresses one provider operation to a scope's namespace; its target dispatches occurrences the provider delivers in process. */
export function createScheduleProviderContext(input: {
  readonly abortSignal: AbortSignal;
  readonly application: string;
  readonly bundle: () => ScheduleDispatchBundle;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  /** The runtime the occurrences it delivers start their sessions in: the host's. */
  readonly runtime: () => Runtime;
  readonly namespace: string;
  readonly operationId: string;
}): ScheduleProviderContext {
  return {
    abortSignal: input.abortSignal,
    collection: input.collection,
    namespace: input.namespace,
    operationId: input.operationId,
    target: {
      key: input.application,
      deliver: async ({ payload, occurrence }) => {
        await dispatchScheduledOccurrence({
          bundle: input.bundle(),
          collection: input.collection,
          runtime: input.runtime(),
          definition: input.definition,
          occurrence: { ...occurrence, collection: input.collection },
          payload: payload as ScheduleCollectionPayload<unknown>,
        });
      },
    },
  };
}

/** The provider namespace of a scope's schedules in one collection. */
export function deriveScheduleNamespace(
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
