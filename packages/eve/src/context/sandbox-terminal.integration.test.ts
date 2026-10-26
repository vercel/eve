import { describe, expect, it } from "vitest";

import { SandboxKey } from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { endSessionSandboxStep } from "#execution/session/end-sandbox-step.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

// Exercise the failed scope and terminal step with the last successful checkpoint,
// not the failed access's uncommitted captureState().
describe("sandbox terminal cleanup after a failed scope", () => {
  it.each(["failed", "expired"] as const)(
    "cleans up by key on %s after initialization opened a sandbox then threw",
    async (reason) => {
      const runtime = await createTestRuntime();
      await runtime.run(async () => {
        const serializedContext = {
          ...buildSerializedContext({ channelKind: "http" }),
          "eve.sessionId": `sandbox-initialization-${reason}`,
        };
        const ctx = await deserializeContext(serializedContext);
        const registered = ctx.require(BundleKey).graph.root.sandboxRegistry.sandbox;
        if (registered?.definition.kind !== "independent") throw new Error("Missing sandbox.");
        const initialize = registered.definition.selector;
        Object.assign(registered.definition, {
          selector: async (context: Parameters<typeof initialize>[0]) => {
            await initialize(context);
            throw new Error("Initialization failed after opening the sandbox.");
          },
        });
        const checkpoint: HarnessSession = {
          agent: { modelReference: { id: "unused" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "sandbox-initialization",
          history: [],
          sessionId: serializedContext["eve.sessionId"],
        };
        await expect(
          withContextScope(ctx, checkpoint, async (session) => {
            await ctx.require(SandboxKey).get();
            return { result: undefined, session };
          }),
        ).rejects.toThrow("Initialization failed after opening the sandbox.");
        expect(checkpoint.sandboxState).toBeUndefined();
        expect(runtime.sandboxCleanups).toEqual([]);

        await endSessionSandboxStep({
          reason,
          serializedContext,
          sessionState: createDurableSessionState({ session: checkpoint }),
        });

        expect(runtime.sandboxCleanups).toEqual([checkpoint.sessionId]);
      });
    },
  );
});
