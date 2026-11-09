import { describe, expect, it, vi } from "vitest";

import type { ScheduleOccurrenceEvent } from "#public/schedules/subscription.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  failed: vi.fn(),
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({}),
}));
vi.mock("#runtime/schedules/dispatch-occurrence.js", () => ({
  dispatchScheduledOccurrence: mocks.admit,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({}),
}));
vi.mock("#runtime/loaders/manifest.js", () => ({
  loadCompiledManifest: async () => ({ config: { name: "fixture" } }),
}));
vi.mock("#runtime/schedules/load-collection.js", () => ({
  ScheduleCollectionNotDeployedError: class extends Error {},
  loadScheduleCollectionDefinition: async () => ({
    provider: {},
    events: { "occurrence.failed": mocks.failed },
  }),
}));

const { createScheduleCollectionConsumer } =
  await import("#internal/nitro/routes/schedule-collection-consumer.js");
const { EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES } =
  await import("#internal/schedules/consumer-route.js");
const { PermanentScheduleMessageError } = await import("#internal/schedules/verify-delivery.js");

const payload = createScheduleCollectionPayload({
  application: "fixture",
  collection: "requests",
  envelope: {
    version: 3,
    payload: { task: "Summarize the week.", destination: "my-dm" },
    scope: "alice",
    principal: { type: "user", authenticator: "test", principalId: "alice" },
  },
});

async function deliver(deliveryCount: number) {
  const consumer = createScheduleCollectionConsumer({
    kind: "production",
    sandboxScope: "fixture",
  });
  const message = {
    source: "dynamic",
    scheduleId: "sch-1",
    name: "weekly",
    namespace: "eve-namespace",
    executionId: "exec-1",
    scheduledAt: "2026-09-29T19:00:00Z",
    payload: { eve: { application: "fixture", collection: "requests", version: 1 }, payload },
  };
  const metadata = {
    createdAt: new Date(),
    expiresAt: new Date("2026-10-09T19:00:00Z"),
    deliveryCount,
    messageId: "msg-1",
    topicName: deriveEveScheduleQueueTopic("fixture"),
    consumerGroup: "fixture",
    region: "dev1",
  };
  const thrown = await Promise.resolve(consumer.handler(message, metadata)).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { thrown, directive: consumer.retry(thrown, metadata) };
}

describe("schedule collection consumer", () => {
  it.each([
    [
      "a transient error before the final delivery",
      new Error("Schedules API 503"),
      1,
      false,
      undefined,
    ],
    [
      "a transient error on the final delivery",
      new Error("Schedules API 503"),
      EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES,
      true,
      undefined,
    ],
    [
      "a permanent error",
      new PermanentScheduleMessageError("Schedule delivery does not match this agent."),
      1,
      true,
      { acknowledge: true },
    ],
  ])(
    "reports %s as failed only when the queue stops retrying",
    async (_label, error, count, reported, directive) => {
      mocks.failed.mockClear();
      mocks.admit.mockRejectedValueOnce(error);

      const result = await deliver(count);

      expect(result.thrown).toBe(error);
      expect(result.directive).toEqual(directive);
      expect(mocks.failed).toHaveBeenCalledTimes(reported ? 1 : 0);
      if (reported)
        expect(mocks.failed.mock.calls[0]![0] as ScheduleOccurrenceEvent).toMatchObject({
          executionId: "exec-1",
          reason: error.message,
          type: "occurrence.failed",
        });
    },
  );
});
