import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelOperations } from "#channel/channel-operations.js";
import { createSession } from "#channel/session.js";
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
      expect(initial[0]!.id).toBe(initial[1]!.id);
      const session = initial[0]!;
      const stream = captureTurnEvents(getRun(session.id));
      let completed = false;
      try {
        await stream.nextTurn();
        await waitForParkedTurnStep(session.id);
        // Each hook resume replays the owner from its recorded history.
        await send();
        const fixed = createSession(session.id, runtime);
        const followUp = () =>
          fixed.send("Bob asks for the next step.", {
            auth: null,
            idempotencyKey: "followup",
            turnPolicy: "queue",
          });
        await Promise.all([followUp(), followUp()]);
        await stream.nextTurn();
        await waitForParkedTurnStep(session.id, 2);
        await followUp();
        await fixed.send("Alice thanks Bob.", { auth: null, turnPolicy: "queue" });
        await stream.nextTurn();
        await waitForParkedTurnStep(session.id, 3);
        await fixed.reset();
        completed = true;
        expect(messages).toHaveLength(3);
      } finally {
        stream.dispose();
        if (!completed && ["pending", "running"].includes(await getRun(session.id).status)) {
          await getRun(session.id).cancel();
        }
      }
    });
  }, 60_000);
});
