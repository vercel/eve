import { createHash, randomUUID } from "node:crypto";
import { scheduleDisplayName } from "#runtime/schedules/record.js";
import { ScheduleDispatcher } from "#channel/schedule.js";
import type { Runtime } from "#channel/types.js";
import type {
  DynamicSchedulesDefinition,
  ScheduleOccurrenceIdentity,
  ScheduleScopeValue,
} from "#public/schedules/subscription.js";
import type { ScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import type { ScheduleProviderContext } from "#runtime/schedules/provider-types.js";
import type { App } from "#runtime/app.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

type ScheduleDispatchBundle = Pick<CompiledRuntimeAgentBundle, "compiledArtifactsSource" | "graph">;

export async function dispatchScheduledOccurrence(input: {
  readonly app: App;
  readonly bundle: ScheduleDispatchBundle;
  readonly runtime: Runtime;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly occurrence: ScheduleOccurrenceIdentity;
  readonly payload: ScheduleCollectionPayload<unknown>;
  readonly namespace?: string;
  readonly verifyDelivery?: () => Promise<void>;
}): Promise<void> {
  const occurrence = {
    ...input.occurrence,
    displayName: scheduleDisplayName(input.occurrence.name),
  };
  const { provider } = input.definition;
  const providerContext = () =>
    createScheduleProviderContext({
      abortSignal: new AbortController().signal,
      app: () => input.app,
      application: input.payload.eve.application,
      bundle: () => input.bundle,
      collection: input.collection,
      runtime: () => input.runtime,
      definition: input.definition,
      namespace: input.namespace,
      operationId: randomUUID(),
      scope: input.payload.envelope.scope,
    });
  const result = await new ScheduleDispatcher({
    app: input.app,
    runtime: input.runtime,
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

export function createScheduleProviderContext(input: {
  readonly abortSignal: AbortSignal;
  readonly app: () => App;
  readonly application: string;
  readonly bundle: () => ScheduleDispatchBundle;
  readonly collection: string;
  readonly definition: DynamicSchedulesDefinition<any, any, any>;
  readonly runtime: () => Runtime;
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
          app: input.app(),
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
