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

describe("caller-reserved session ids", () => {
  it("never hands another principal's create to a session its owner reserved", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createTestRuntime({
      agent: { name: "reserved-session", limits: { sessionTimeoutMs: false } },
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
    await runtime.run(async () => {
      const world = await getWorld();
      const queue = vi.spyOn(world, "queue");
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
        const startsBefore = queue.mock.calls.length;

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
        expect(queue.mock.calls.length).toBe(startsBefore);
        const events = await world.events.list({
          runId: sessionId,
          resolveData: "all",
          pagination: { limit: 1000 },
        });
        const created = events.data.filter((event) => event.eventType === "run_created");
        expect(created).toHaveLength(1);
        if (created[0]?.eventType !== "run_created") throw new Error("Missing run creation.");
        const [input] = await hydrateWorkflowArguments(
          created[0].eventData.input,
          sessionId,
          undefined,
        );
        expect(input).toMatchObject({ input: { message: "alice's request" } });
        expect(JSON.stringify(input)).not.toContain("mallory");
        expect(JSON.stringify(events.data)).not.toContain("mallory");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
