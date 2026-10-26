import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelOperations } from "#channel/channel-operations.js";
import { createSession } from "#channel/session.js";
import { deliveryIdForIdempotencyKey } from "#channel/delivery-idempotency.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { waitForParkedTurnStep } from "#internal/testing/session-test-helpers.js";
import { defineHook } from "#public/definitions/hook.js";

afterEach(() => vi.unstubAllEnvs());

describe("delivery idempotency", () => {
  it("deduplicates racing initial and follow-up sends across addresses and replay", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
    const messages: string[] = [];
    const app = await createTestRuntime({
      agent: { name: "keyed-delivery", limits: { sessionTimeoutMs: false } },
      modules: [
        {
          logicalPath: "hooks/record.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.started"() {
                  messages.push("turn");
                },
              },
            }),
          }),
        },
      ],
    });
    await app.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const operations = () =>
        createChannelOperations({ adapter: { kind: "http" }, channelName: "test", runtime });
      const address = crypto.randomUUID();
      const send = () =>
        operations()
          .from(address)
          .send("Alice asks for a report.", { auth: null, idempotencyKey: "initial" });
      const initial = await Promise.all([send(), send()]);
      expect(initial[0]!.sessionId).toBe(initial[1]!.sessionId);
      const session = initial[0]!;
      const stream = captureTurnEvents(getRun(session.sessionId));
      let completed = false;
      try {
        await stream.nextTurn();
        await waitForParkedTurnStep(session.sessionId);
        const firstResults = await Promise.all(
          initial.map((receipt) => receipt.result({ signal: AbortSignal.timeout(5_000) })),
        );
        expect(firstResults.map((result) => result.outcome).sort()).toEqual(["handled", "ignored"]);
        // Each hook resume replays the owner from its recorded history.
        expect((await (await send()).result({ signal: AbortSignal.timeout(5_000) })).outcome).toBe(
          "ignored",
        );
        const fixed = createSession(session.sessionId, runtime);
        const followUp = () =>
          fixed.send("Bob asks for the next step.", {
            auth: null,
            idempotencyKey: "followup",
            turnPolicy: "queue",
          });
        await Promise.all([followUp(), followUp()]);
        await stream.nextTurn();
        await waitForParkedTurnStep(session.sessionId, 2);
        expect(
          (await (await followUp()).result({ signal: AbortSignal.timeout(5_000) })).outcome,
        ).toBe("ignored");
        await fixed.send("Alice thanks Bob.", { auth: null, turnPolicy: "queue" });
        await stream.nextTurn();
        await waitForParkedTurnStep(session.sessionId, 3);
        await fixed.reset();
        completed = true;
        expect(messages).toHaveLength(3);
      } finally {
        stream.dispose();
        if (!completed && ["pending", "running"].includes(await getRun(session.sessionId).status)) {
          await getRun(session.sessionId).cancel();
        }
      }
    });
  }, 60_000);

  it("gives a keyed request's repeat the original receipt, as the session route does", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", await (await getWorld()).getDeploymentId());
    let turns = 0;
    const app = await createTestRuntime({
      agent: { name: "keyed-receipt", limits: { sessionTimeoutMs: false } },
      modules: [
        {
          logicalPath: "hooks/record.ts",
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.started"() {
                  turns += 1;
                },
              },
            }),
          }),
        },
      ],
    });
    await app.run(async () => {
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const started = await createChannelOperations({
        adapter: { kind: "http" },
        channelName: "test",
        runtime,
      })
        .from(crypto.randomUUID())
        .send("Alice opens the session.", { auth: null });
      const stream = captureTurnEvents(getRun(started.sessionId));
      let completed = false;
      try {
        await stream.nextTurn();
        await waitForParkedTurnStep(started.sessionId);
        // A parent's retried continue step: the same key, so the route names the same delivery.
        const idempotencyKey = "agent-session:run_0:step_3:child:send";
        const deliveryId = await deliveryIdForIdempotencyKey(idempotencyKey);
        const fixed = createSession(started.sessionId, runtime);
        const continueOnce = () =>
          fixed.send("Bob asks for the next step.", {
            auth: null,
            deliveryId,
            idempotencyKey,
            turnPolicy: "queue",
          } as Parameters<typeof fixed.send>[1]);
        const first = await continueOnce();
        const repeat = await continueOnce();
        expect(first.deliveryId).toBe(deliveryId);
        expect(repeat.deliveryId).toBe(deliveryId);
        await stream.nextTurn();
        await waitForParkedTurnStep(started.sessionId, 2);
        const outcomes = await Promise.all(
          [first, repeat].map(
            async (receipt) =>
              (await receipt.result({ signal: AbortSignal.timeout(5_000) })).outcome,
          ),
        );
        // One delivery, read once: both receipts are it, and neither is a duplicate's.
        expect(outcomes).toEqual(["handled", "handled"]);
        await fixed.reset();
        completed = true;
        expect(turns).toBe(2);
      } finally {
        stream.dispose();
        if (!completed && ["pending", "running"].includes(await getRun(started.sessionId).status)) {
          await getRun(started.sessionId).cancel();
        }
      }
    });
  }, 60_000);
});
