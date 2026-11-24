import { describe, expect, it } from "vitest";

import { fenceClosedWorld, trackDeliveries } from "#internal/testing/workflow-test-world.js";

function delivery(messageId: string, body: unknown = {}): Request {
  return new Request("http://localhost/flow", {
    body: JSON.stringify(body),
    headers: { "x-vqs-message-id": messageId },
    method: "POST",
  });
}

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

    await deliveries.handler(delivery("delayed"));

    expect(await settles(deliveries.idle())).toBe(false);
  });

  it("stays busy while a message woken by its timer is handed back at once", async () => {
    let answer = Response.json({ timeoutSeconds: 5 });
    const deliveries = trackDeliveries(async () => answer);
    deliveries.queued("sleeping", false);
    await deliveries.handler(delivery("sleeping"));
    expect(await settles(deliveries.idle())).toBe(true);

    answer = Response.json({ timeoutSeconds: 0 });
    await deliveries.handler(delivery("sleeping"));

    expect(await settles(deliveries.idle())).toBe(false);
  });

  it("settles once a coalesced single-orchestrator wake runs as the holder's re-run", async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const deliveries = trackDeliveries(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return Response.json({ ok: true });
    });

    deliveries.queued("msg_1", false);
    const first = deliveries.handler(delivery("msg_1", { runId: "run_1", runSpecVersion: 10 }));
    await new Promise((resolve) => setImmediate(resolve));

    const at = deliveries.checkpoint();
    deliveries.queued("msg_2", false, "run_1", at);

    releaseFirst();
    await first;
    expect(await settles(deliveries.idle())).toBe(false);

    await deliveries.handler(delivery("msg_1", { runId: "run_1", runSpecVersion: 10 }));
    expect(await settles(deliveries.idle())).toBe(true);
  });
});

describe("fenceClosedWorld", () => {
  it("refuses every call a handler from before the restart makes on the closed World", () => {
    const written: string[] = [];
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
