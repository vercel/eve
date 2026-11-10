import { describe, expect, it, vi } from "vitest";

import type { ScheduleOccurrenceEvent } from "#public/schedules/subscription.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  auth: vi.fn(),
  failed: vi.fn(),
  run: vi.fn(),
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({}),
}));
vi.mock("#runtime/schedules/dispatch-occurrence.js", () => ({
  dispatchScheduledOccurrence: mocks.admit,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => ({ graph: { root: { channels: [] } } }),
}));
vi.mock("#runtime/loaders/manifest.js", () => ({
  loadCompiledManifest: async () => ({ config: { name: "fixture" } }),
}));
vi.mock("#runtime/schedules/load-collection.js", () => ({
  ScheduleCollectionNotDeployedError: class extends Error {},
  loadScheduleCollectionDefinition: async () => ({
    provider: {},
    preparePayload: (value: unknown) => value,
    auth: mocks.auth,
    run: mocks.run,
    events: { "occurrence.failed": mocks.failed },
  }),
}));
vi.mock("#compiled/@vercel/schedules/index.js", () => ({
  SchedulesApiError: class extends Error {},
  SchedulesClient: class {
    async get({ name, namespace }: { name: string; namespace: string }) {
      return {
        name,
        namespace,
        scheduleId: "sch-1",
        source: "dynamic",
        target: { type: "queue", topic: deriveEveScheduleQueueTopic("fixture") },
      };
    }
  },
}));

const { createScheduleCollectionConsumer } =
  await import("#internal/nitro/routes/schedule-collection-consumer.js");
const { EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES } =
  await import("#internal/schedules/consumer-route.js");
const { PermanentScheduleMessageError } = await import("#internal/schedules/verify-delivery.js");
const { dispatchScheduledOccurrence } = await vi.importActual<
  typeof import("#runtime/schedules/dispatch-occurrence.js")
>("#runtime/schedules/dispatch-occurrence.js");

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

  it("acknowledges an occurrence its auth denies and reports it failed once", async () => {
    mocks.failed.mockClear();
    mocks.admit.mockImplementationOnce(dispatchScheduledOccurrence);
    mocks.auth.mockResolvedValueOnce(null);

    const result = await deliver(1);

    expect(result.directive).toEqual({ acknowledge: true });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledTimes(1);
    expect(mocks.failed.mock.calls[0]![0] as ScheduleOccurrenceEvent).toMatchObject({
      executionId: "exec-1",
      reason: expect.stringContaining("no longer authorized"),
      type: "occurrence.failed",
    });
  });

  it("retries an occurrence whose auth throws", async () => {
    mocks.failed.mockClear();
    mocks.admit.mockImplementationOnce(dispatchScheduledOccurrence);
    const failure = new Error("identity service unavailable");
    mocks.auth.mockRejectedValueOnce(failure);

    const result = await deliver(1);

    expect(result.thrown).toBe(failure);
    expect(result.directive).toBeUndefined();
    expect(mocks.failed).not.toHaveBeenCalled();
  });
});
