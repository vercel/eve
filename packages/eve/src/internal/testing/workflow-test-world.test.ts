import { describe, expect, it } from "vitest";

import { fenceClosedWorld, trackDeliveries } from "#internal/testing/workflow-test-world.js";

function delivery(messageId: string): Request {
  return new Request("http://localhost/flow", {
    body: "{}",
    headers: { "x-vqs-message-id": messageId },
    method: "POST",
  });
}

/** Whether `idle()` resolves within a few macrotasks. */
async function settles(idle: Promise<void>): Promise<boolean> {
  let settled = false;
  void idle.then(() => (settled = true));
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe("trackDeliveries", () => {
  it("stays busy while a delayed message's failed delivery waits for its redelivery", async () => {
    const deliveries = trackDeliveries(async () => new Response("failed", { status: 500 }));
    deliveries.queued("delayed", true);

    // The delay ends and the delivery fails, so the queue redelivers it later.
    await deliveries.handler(delivery("delayed"));

    expect(await settles(deliveries.idle())).toBe(false);
  });

  it("stays busy while a message woken by its timer is handed back at once", async () => {
    let answer = Response.json({ timeoutSeconds: 5 });
    const deliveries = trackDeliveries(async () => answer);
    deliveries.queued("sleeping", false);
    await deliveries.handler(delivery("sleeping"));
    expect(await settles(deliveries.idle())).toBe(true);

    // The timer fires and the handler hands the message straight back.
    answer = Response.json({ timeoutSeconds: 0 });
    await deliveries.handler(delivery("sleeping"));

    expect(await settles(deliveries.idle())).toBe(false);
  });
});

describe("fenceClosedWorld", () => {
  it("refuses every call a handler from before the restart makes on the closed World", () => {
    const written: string[] = [];
    // What a handler holds: the World, and its namespaces.
    const world = {
      events: { create: async (runId: string) => void written.push(runId) },
      specVersion: 8,
      writeToStream: async (name: string) => void written.push(name),
    };
    const { events } = world;

    fenceClosedWorld(world);

    expect(() => events.create("run_1")).toThrow("This World is closed");
    expect(() => world.writeToStream("stream_1")).toThrow("This World is closed");
    expect(written).toEqual([]);
    expect(world.specVersion).toBe(8);
  });
});
