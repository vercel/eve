import { hydrateWorkflowArguments } from "@workflow/core/serialization";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { expectSingleTurn } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { dispatchChannelRequest } from "#internal/nitro/routes/channel-dispatch.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { eveChannel } from "#public/channels/eve.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function reservedRunId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = Date.now();
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    encoded = alphabet[timestamp % 32] + encoded;
    timestamp = Math.floor(timestamp / 32);
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) => alphabet[v % 32]);
  return `wrun_${encoded}${random.join("")}`;
}

async function create(principalId: string, body: Record<string, unknown>): Promise<Response> {
  return await dispatchChannelRequest(
    {
      req: new Request("https://example.com/eve/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-principal": principalId },
        body: JSON.stringify(body),
      }),
      context: { params: {} },
      waitUntil: () => {},
    } as never,
    "POST /eve/v1/session",
    { kind: "production", sandboxScope: "test" },
  );
}

const runtimeFor = async (name: string) =>
  await createTestRuntime({
    agent: { name, limits: { sessionTimeoutMs: false } },
    modules: [
      {
        logicalPath: "channels/eve.ts",
        loadNamespace: async () => ({
          default: eveChannel({
            auth: [
              (request: Request) => ({
                attributes: {},
                authenticator: "test",
                principalId: request.headers.get("x-test-principal") ?? "",
                principalType: "user",
              }),
            ],
            turnPolicy: "queue",
          }),
        }),
      },
    ],
  });

async function storedRun(sessionId: string) {
  const world = await getWorld();
  const events = await world.events.list({
    runId: sessionId,
    resolveData: "all",
    pagination: { limit: 1000 },
  });
  const created = events.data.filter((event) => event.eventType === "run_created");
  expect(created).toHaveLength(1);
  if (created[0]?.eventType !== "run_created") throw new Error("Missing run creation.");
  const [input] = await hydrateWorkflowArguments(created[0].eventData.input, sessionId, undefined);
  return { events: JSON.stringify(events.data), input };
}

describe("caller-reserved session ids", () => {
  it("never hands another principal's create to a session its owner reserved", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await runtimeFor("reserved-session");
    await runtime.run(async () => {
      const world = await getWorld();
      const queue = vi.spyOn(world, "queue");
      const runMessages = () =>
        queue.mock.calls.filter((call) => !(call[1] as { __healthCheck?: boolean }).__healthCheck);
      const sessionId = reservedRunId();

      const first = await create("alice", {
        message: "alice's request",
        sessionId,
        deliveryId: "dlv_alice",
      });
      expect(first.status).toBe(202);
      const run = getRun(sessionId);
      const stream = captureTurnEvents(run);
      try {
        expectSingleTurn(await stream.nextTurn(), "turn_0");
        const startsBefore = runMessages().length;

        const second = await create("mallory", {
          message: "mallory's request",
          sessionId,
          deliveryId: "dlv_mallory",
        });

        expect(second.status).toBe(200);
        expect(await second.json()).toMatchObject({
          existing: true,
          deliveryId: "dlv_alice",
          sessionId,
        });
        // The losing create publishes nothing: no queue message can carry its
        // input or auth into the owner's run.
        expect(runMessages().length).toBe(startsBefore);
        const stored = await storedRun(sessionId);
        expect(stored.input).toMatchObject({ input: { message: "alice's request" } });
        expect(stored.events).not.toContain("mallory");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it.each([
    { case: "the queue rejects the first publication", lands: false, retryAs: "mallory" },
    { case: "the first publication lands but its response is lost", lands: true, retryAs: "alice" },
  ])("a same-id retry recovers the original turn when $case", async ({ lands, retryAs }) => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await runtimeFor(`reserved-session-recovery-${String(lands)}`);
    await runtime.run(async () => {
      const world = await getWorld();
      const sessionId = reservedRunId();
      const original = world.queue;
      const published: unknown[] = [];
      let failNext = true;
      let lateDelivery: (() => Promise<unknown>) | undefined;
      world.queue = async function (this: unknown, ...args: Parameters<typeof original>) {
        const message = args[1] as { runId?: string; __healthCheck?: boolean };
        if (message.runId !== sessionId || message.__healthCheck)
          return await original.apply(this, args);
        published.push(message);
        if (!failNext) return await original.apply(this, args);
        failNext = false;
        // A landed publication whose response was lost: it is delivered
        // late, after the retry has already re-published the run.
        if (lands) lateDelivery = async () => await original.apply(this, args);
        throw new Error("queue publication failed");
      };

      const first = await create("alice", {
        message: "alice's request",
        sessionId,
        deliveryId: "dlv_alice",
      });
      expect(first.status).toBeGreaterThanOrEqual(500);

      const retry = await create(retryAs, {
        message: "alice's retry",
        sessionId,
        deliveryId: "dlv_retry",
      });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        existing: true,
        deliveryId: "dlv_alice",
        sessionId,
      });

      await lateDelivery?.();

      const run = getRun(sessionId);
      const stream = captureTurnEvents(run);
      try {
        expectSingleTurn(await stream.nextTurn(), "turn_0");
        // Recovery re-publishes from the stored run, so no queue message
        // carries the retry's input or delivery identity.
        expect(published).toContainEqual({ runId: sessionId });
        expect(JSON.stringify(published.slice(1))).not.toContain("alice's retry");
        expect(JSON.stringify(published.slice(1))).not.toContain("dlv_retry");
        expect(JSON.stringify(published)).not.toContain("mallory");
        const stored = await storedRun(sessionId);
        expect(stored.input).toMatchObject({ input: { message: "alice's request" } });
        expect(stored.events).not.toContain("alice's retry");
        expect(stored.events).not.toContain("dlv_retry");
        expect(JSON.stringify(stored.input)).not.toContain("mallory");
        expect(stored.events).not.toContain("mallory");
        // A duplicate delivery replays the run; it never re-creates a step or
        // hook, so the turn's work happens once.
        const created = (
          JSON.parse(stored.events) as { eventType: string; correlationId?: string }[]
        )
          .filter(
            (event) => event.eventType === "step_created" || event.eventType === "hook_created",
          )
          .map((event) => event.correlationId);
        expect(created.length).toBeGreaterThan(0);
        expect(new Set(created).size).toBe(created.length);
      } finally {
        world.queue = original;
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
