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
    async "session.completed"() {
      terminalEvents.push("session.completed");
      failAnchorStreamWrites = true;
    },
    async "session.failed"() {
      terminalEvents.push("session.failed");
    },
  },
  routes: [POST("/test", async () => new Response("ok"))],
});

afterEach(() => {
  failAnchorStreamWrites = false;
  terminalEvents = [];
  vi.restoreAllMocks();
});

// On Vercel, a session's stream stays on its first run. Once that run's deployment is deleted,
// its run key is gone and every write fails as a FatalError, the way this test injects it.
// Expected failure until #5261 is fixed: the expired session is reported as failed.
it.fails("does not report an expired session as failed when its terminal stream write fails", async () => {
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
    let failedStreamWrites = 0;
    const failAnchorWrite = async (runId: string | Promise<string>): Promise<boolean> => {
      if (!failAnchorStreamWrites || (await runId) !== run.runId) return false;
      failedStreamWrites += 1;
      return true;
    };

    const write = world.streams.write.bind(world.streams);
    vi.spyOn(world.streams, "write").mockImplementation(async (runId, name, chunk) => {
      if (await failAnchorWrite(runId))
        throw new FatalError("simulated terminal stream write failure");
      await write(runId, name, chunk);
    });

    const writeMulti = world.streams.writeMulti?.bind(world.streams);
    if (writeMulti !== undefined) {
      vi.spyOn(world.streams, "writeMulti").mockImplementation(async (runId, name, chunks) => {
        if (await failAnchorWrite(runId)) {
          throw new FatalError("simulated terminal stream write failure");
        }
        await writeMulti(runId, name, chunks);
      });
    }

    try {
      await run.returnValue.catch(() => undefined);
      expect(failedStreamWrites).toBeGreaterThan(0);
      expect(terminalEvents).toEqual(["session.completed"]);
    } finally {
      await run.cancel().catch(() => undefined);
    }
  });
});
