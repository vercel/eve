import { describe, expect, it, vi } from "vitest";

import type { ScheduleOccurrenceEvent } from "#public/schedules/collection.js";
import { createScheduleCollectionPayload } from "#runtime/schedules/payload.js";
import { deriveEveScheduleQueueTopic } from "#runtime/schedules/queue-namespace.js";

type Callback = (message: unknown, metadata: Record<string, unknown>) => Promise<void>;
type RetryHandler = (error: unknown) => unknown;

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  failed: vi.fn(),
  queue: {} as { callback?: Callback; retry?: RetryHandler },
}));
vi.mock("@vercel/queue", () => ({
  handleCallback: (callback: Callback, options: { retry: RetryHandler }) => {
    mocks.queue.callback = callback;
    mocks.queue.retry = options.retry;
    return async () => new Response(null);
  },
}));
vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: () => ({}),
}));
vi.mock("#runtime/schedules/admit-occurrence.js", () => ({
  admitScheduledOccurrence: mocks.admit,
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

const { handleScheduleCollectionConsumer } =
  await import("#internal/nitro/routes/schedule-collection-consumer.js");
const { EVE_SCHEDULE_CONSUMER_MAX_DELIVERIES } =
  await import("#internal/schedules/consumer-route.js");
const { PermanentScheduleMessageError } = await import("#internal/schedules/verify-delivery.js");

const payload = createScheduleCollectionPayload({
  application: "fixture",
  collection: "requests",
  envelope: {
    version: 2,
    request: "Summarize the week.",
    scope: "alice",
    principal: { type: "user", authenticator: "test", principalId: "alice" },
    metadata: {},
    deliveries: { archive: {} },
  },
});

async function deliver(deliveryCount: number) {
  await handleScheduleCollectionConsumer({} as never, new Request("https://agent.test"));
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
    deliveryCount,
    messageId: "msg-1",
    topicName: deriveEveScheduleQueueTopic("fixture"),
  };
  return await mocks.queue.callback!(message, metadata).then(
    () => undefined,
    (error: unknown) => error,
  );
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

      const thrown = await deliver(count);

      expect(thrown).toBe(error);
      expect(mocks.queue.retry!(thrown)).toEqual(directive);
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
