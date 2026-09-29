import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapterContext } from "#channel/adapter.js";
import { createScheduleCollectionAdapterState } from "#channel/schedule-collection-adapter.js";
import { SCHEDULE_ADAPTER } from "#channel/schedule.js";
import {
  defineScheduleCollection,
  type ScheduleCollectionDefinition,
  type ScheduleDeliveryBinding,
} from "#public/schedules/collection.js";
import { DeliveryRejected, type ScheduleDeliveryDefinition } from "#public/schedules/delivery.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
// Registers the bundle key the settle step resolves by name, as the runtime always has.
import "#runtime/sessions/runtime-context-keys.js";

// The settle step reloads the collection from the compiled bundle; supply it directly.
const loaded = vi.hoisted(() => ({ definition: undefined as unknown }));
vi.mock("#runtime/schedules/load-collection.js", () => ({
  loadScheduleCollectionDefinition: async () => loaded.definition,
}));

const occurrence = {
  collection: "requests",
  executionId: "exec-1",
  name: "weekly",
  scheduleId: "sch-1",
  scheduledAt: "2026-09-29T19:00:00Z",
};
const creator = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};
const turn = { sequence: 0, turnId: "turn_0" };
const events = { succeeded: vi.fn(), failed: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function occurrenceSession(
  deliveries: Record<string, ScheduleDeliveryDefinition<any>>,
  options: {
    bindings?: Record<string, ScheduleDeliveryBinding>;
    auth?: typeof creator | null;
  } = {},
) {
  const definition: ScheduleCollectionDefinition<unknown, unknown> = defineScheduleCollection({
    provider: inMemoryScheduleProvider(),
    auth: () => (options.auth === undefined ? creator : options.auth),
    deliveries,
    events: { "delivery.succeeded": events.succeeded, "delivery.failed": events.failed },
  }) as never;
  loaded.definition = definition;
  const context: ChannelAdapterContext = {
    // The mocked loader ignores the bundle this resolves.
    ctx: { require: () => ({}) } as never,
    session: { id: "session-1", auth: { current: creator, initiator: null } },
    state: createScheduleCollectionAdapterState({
      collection: "requests",
      deliveries: Object.fromEntries(
        Object.keys(deliveries).map((name) => [name, options.bindings?.[name] ?? {}]),
      ),
      metadata: {},
      occurrence,
      principal: { type: "user", authenticator: "test", principalId: "alice" },
    }),
  };
  const emit = async (type: string, data: unknown) =>
    await (SCHEDULE_ADAPTER as Record<string, any>)[type](data, context);
  return { emit };
}

const failedReasons = () =>
  Object.fromEntries(events.failed.mock.calls.map(([event]) => [event.delivery, event.reason]));

describe("schedule collection deliveries", () => {
  it("delivers a single-delivery occurrence's final reply once, as the re-resolved creator", async () => {
    const order: string[] = [];
    const verify = vi.fn(async () => (order.push("verify"), true as const));
    const deliver = vi.fn(async () => void order.push("deliver"));
    const { emit } = occurrenceSession(
      { thread: { description: "Reply in the thread.", verify, deliver } },
      { bindings: { thread: { binding: { channelId: "C1" } } } },
    );

    await emit("message.completed", {
      ...turn,
      finishReason: "stop",
      message: " Octopuses have three hearts. ",
      stepIndex: 0,
    });
    await emit("turn.completed", turn);
    await emit("turn.completed", turn);

    expect(order).toEqual(["verify", "deliver"]);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ attributes: { "eve.scheduled_run": "true" } }),
        binding: { channelId: "C1" },
        content: "Octopuses have three hearts.",
        idempotencyKey: "exec-1:thread",
      }),
    );
    expect(events.succeeded).toHaveBeenCalledOnce();
  });

  it("gives each delivery its own content and outcome", async () => {
    const sent = vi.fn(async () => {});
    const rejected = vi.fn(async () => {
      throw new DeliveryRejected("SMS is too long.");
    });
    const refusedDeliver = vi.fn(async () => {});
    const { emit } = occurrenceSession({
      archive: { description: "Archive.", deliver: sent },
      sms: { description: "Text.", deliver: rejected },
      dm: {
        description: "DM.",
        verify: async () => ({ allowed: false, reason: "The creator left the workspace." }),
        deliver: refusedDeliver,
      },
    });

    await emit("result.completed", {
      ...turn,
      result: { archive: "Full report.", sms: "Short.", dm: "Hi." },
      stepIndex: 0,
    });
    await emit("turn.completed", turn);

    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ content: "Full report." }));
    expect(rejected).toHaveBeenCalledOnce();
    expect(refusedDeliver).not.toHaveBeenCalled();
    expect(failedReasons()).toEqual({
      sms: "SMS is too long.",
      dm: "The creator left the workspace.",
    });
  });

  it("retries a transient delivery error", async () => {
    vi.useFakeTimers();
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("Slack 503"))
      .mockResolvedValue(undefined);
    const { emit } = occurrenceSession({ thread: { description: "Reply.", deliver } });

    await emit("message.completed", {
      ...turn,
      finishReason: "stop",
      message: "Fact.",
      stepIndex: 0,
    });
    const settled = emit("turn.completed", turn);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(events.succeeded).toHaveBeenCalledOnce();
    expect(events.failed).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the turn fails",
      {},
      "turn.failed",
      { ...turn, code: "MODEL_CALL_FAILED", message: "Model unavailable." },
      "The occurrence's turn failed: Model unavailable.",
    ],
    [
      "the creator is no longer authorized",
      { auth: null },
      "turn.completed",
      turn,
      "Scheduled execution is no longer authorized.",
    ],
  ] as const)("delivers nothing when %s", async (_label, options, type, data, reason) => {
    const deliver = vi.fn(async () => {});
    const { emit } = occurrenceSession({ thread: { description: "Reply.", deliver } }, options);

    await emit("message.completed", {
      ...turn,
      finishReason: "stop",
      message: "Fact.",
      stepIndex: 0,
    });
    await emit(type, data);

    expect(deliver).not.toHaveBeenCalled();
    expect(failedReasons()).toEqual({ thread: reason });
  });
});
