import { describe, expect, it, vi } from "vitest";

import { defineScheduleCollection } from "#public/schedules/collection.js";
import { defineScheduleDelivery } from "#public/schedules/delivery.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import {
  createScheduleCollectionClient,
  type ScheduleBoundCallContext,
} from "#runtime/schedules/collection-client.js";

const callContext: ScheduleBoundCallContext = {
  abortSignal: new AbortController().signal,
  application: "fixture",
  collection: "requests",
  channel: {
    currentTarget: () => {
      throw new Error("unused");
    },
    mintPersonalTarget: async () => {
      throw new Error("unused");
    },
  },
  session: {
    id: "session-alice",
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
        principalId: "alice",
        principalType: "user",
      },
      initiator: null,
    },
  },
};

function setup(capture: { a?: () => unknown; b?: () => unknown } = {}) {
  const provider = inMemoryScheduleProvider();
  const create = vi.spyOn(provider, "create");
  const deliver = async () => {};
  const collection = defineScheduleCollection({
    provider,
    auth: () => null,
    deliveries: {
      a: defineScheduleDelivery({ description: "First.", capture: capture.a as never, deliver }),
      b: defineScheduleDelivery({ description: "Second.", capture: capture.b as never, deliver }),
    },
  });
  const client = createScheduleCollectionClient(collection, callContext);
  const createWith = (deliveries: unknown) =>
    client.create({
      name: "report",
      expression: { type: "delay", minutes: 5 },
      request: "Summarize the week.",
      deliveries: deliveries as string[],
    });
  return { create, createWith };
}

describe("schedule collection client create", () => {
  it.each([[undefined], [[]], [["sms"]]])(
    "refuses a schedule without a configured delivery (%j) and stores nothing",
    async (deliveries) => {
      const { create, createWith } = setup();
      await expect(createWith(deliveries)).rejects.toThrow(/a \(First\.\); b \(Second\.\)/u);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("stores nothing when any capture refuses, and reports which delivery refused", async () => {
    const first = vi.fn(() => ({ binding: "kept" }));
    const { create, createWith } = setup({
      a: first,
      b: () => {
        throw new Error("No phone on file.");
      },
    });
    await expect(createWith(["a", "b"])).rejects.toThrow(
      'Delivery "b" cannot be used: No phone on file.',
    );
    expect(first).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("stores captured bindings with the schedule and returns only their labels", async () => {
    const { create, createWith } = setup({
      a: () => ({ label: " DM to Alice ", binding: { userId: "alice" } }),
    });
    const created = await createWith(["a", "b", "a"]);

    expect(create.mock.calls[0]![1].payload).toMatchObject({
      envelope: {
        version: 2,
        deliveries: { a: { label: "DM to Alice", binding: { userId: "alice" } }, b: {} },
      },
    });
    expect(created.deliveries).toEqual([{ name: "a", label: "DM to Alice" }, { name: "b" }]);
  });
});
