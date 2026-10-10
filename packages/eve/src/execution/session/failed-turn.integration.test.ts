import { afterEach, expect, it } from "vitest";

import { createSession } from "#channel/session.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  finalizeInstrumentationProviders,
  registerInstrumentationProvider,
} from "#instrumentation/providers.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { start } from "#internal/workflow/runtime.js";
import { defineInstrumentation } from "#public/instrumentation/index.js";
import { defineMemory } from "#public/memory/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const REGISTRY_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");
const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_GLOBAL_KEY];
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
});

it("attributes a failure to the running turn after a compaction hands the session to a new owner", async () => {
  const agentName = "failed-turn-after-handoff";
  const failedTurnIds: (string | undefined)[] = [];
  await registerInstrumentationProvider({
    agentName,
    slot: "capture",
    value: defineInstrumentation({
      events: {
        "session.failed": (event) => {
          failedTurnIds.push(event.turnId);
        },
      },
    }),
  });
  finalizeInstrumentationProviders({ serviceName: agentName });

  const runtime = await createTestRuntime({
    agent: { name: agentName },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineMemory({
            provider: {
              recall: {
                // The second turn's recall fails the session; an abort-shaped error isn't retried.
                "turn.started": async (context) => {
                  if (context.turn.sequence === 0) return null;
                  throw Object.assign(new Error("This operation was aborted"), {
                    name: "AbortError",
                  });
                },
              },
            },
            scope: "test",
          }),
        }),
        logicalPath: "memory/failing-recall.ts",
      },
    ],
  });
  const workflowRuntime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  });

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Alice asks for the weekly summary." },
        serializedContext: buildSerializedContext({
          channelKind: "http",
          continuationToken: `http:${agentName}`,
        }),
      },
    ]);
    const stream = captureTurnEvents(run);
    const session = createSession(run.runId, workflowRuntime);
    try {
      await stream.nextTurn();
      await session.compact();
      // A compaction between turns settles its context change; no turn ends.
      await stream.nextUntil((event) => event.type === "context.settled");

      await session.send("Bob asks for the summary again.", { auth: null });
      const failed = await stream.nextTurn();
      expect(filterEventsByType(failed, "turn.started")).toMatchObject([
        { data: { turnId: "turn_1" } },
      ]);
      expect(failed.at(-1)).toMatchObject({ data: { outcome: "failed" }, type: "session.ended" });
    } finally {
      stream.dispose();
    }
  });

  expect(failedTurnIds).toEqual(["turn_1"]);
}, 60_000);
