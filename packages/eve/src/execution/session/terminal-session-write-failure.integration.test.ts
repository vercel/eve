import { afterEach, expect, it, vi } from "vitest";
import { FatalError } from "#compiled/@workflow/core/index.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { workflowEntry } from "#execution/session/entry.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { defineChannel, POST } from "#public/definitions/channel.js";

let failAnchorStreamWrites = false;
let terminalEvents: string[] = [];

const terminalWriteFailureChannel = defineChannel({
  events: {
    async "session.ended"({ data }) {
      terminalEvents.push(data.outcome);
      if (data.outcome === "completed") failAnchorStreamWrites = true;
    },
  },
  routes: [POST("/test", async () => new Response("ok"))],
});

afterEach(() => {
  failAnchorStreamWrites = false;
  terminalEvents = [];
  vi.restoreAllMocks();
});

// The terminal fact commits before channel delivery in v27. Fail the following stream close,
// after the channel has handled completion, rather than failing an uncommitted fact's write.
it("does not report an expired session as failed when its terminal stream close fails", async () => {
  const runtime = await createTestRuntime({
    agent: { name: "terminal-session-write-failure" },
    modules: [
      {
        logicalPath: "channels/terminal-write-failure.ts",
        loadNamespace: async () => ({ default: terminalWriteFailureChannel }),
      },
    ],
  });

  await runtime.run(async () => {
    const world = await getWorld();
    let anchorRunId: string | undefined;
    let failedStreamWrites = 0;
    const failAnchorWrite = async (runId: string | Promise<string>): Promise<boolean> => {
      if (!failAnchorStreamWrites || (await runId) !== anchorRunId) return false;
      failedStreamWrites += 1;
      return true;
    };

    const close = world.streams.close.bind(world.streams);
    vi.spyOn(world.streams, "close").mockImplementation(async (runId, name) => {
      if (await failAnchorWrite(runId))
        throw new FatalError("simulated terminal stream close failure");
      await close(runId, name);
    });

    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Say hello." },
        serializedContext: buildSerializedContext({
          channelKind: "channel:terminal-write-failure",
        }),
        sessionTimeoutMs: 25,
      },
    ]);
    anchorRunId = run.runId;

    try {
      await expect(run.returnValue).rejects.toThrow("Agent workflow failed");
      expect(failedStreamWrites).toBeGreaterThan(0);
      expect(terminalEvents).toEqual(["completed"]);
    } finally {
      await run.cancel().catch(() => undefined);
    }
  });
});
