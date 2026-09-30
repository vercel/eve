import { describe, expect, it } from "vitest";

import { readSessionEvents } from "#execution/read-session-events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";

describe("readSessionEvents", () => {
  it("reads a parked session's stream in bounded pages without waiting for new events", async () => {
    const runtime = await createTestRuntime({ agent: { name: "read-session-events" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Say hello." },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:read-session-events",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const turn = await stream.nextTurn();
        expect(turn.at(-1)?.type).toBe("session.waiting");

        const first = await readSessionEvents({ limit: 2, sessionId: run.runId, startIndex: 0 });
        expect(first).toMatchObject({ caughtUp: false, nextIndex: 2 });
        expect(first.events.map((event) => event.type)).toEqual(
          turn.slice(0, 2).map((event) => event.type),
        );

        const rest = await readSessionEvents({
          limit: 1_000,
          sessionId: run.runId,
          startIndex: first.nextIndex,
        });
        expect(rest).toMatchObject({ caughtUp: true, nextIndex: turn.length });
        expect(rest.events.map((event) => event.type)).toEqual(
          turn.slice(2).map((event) => event.type),
        );

        // The session is parked: reading at its tail returns at once instead of following it.
        await expect(
          readSessionEvents({ limit: 1_000, sessionId: run.runId, startIndex: rest.nextIndex }),
        ).resolves.toEqual({ caughtUp: true, events: [], nextIndex: turn.length });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
