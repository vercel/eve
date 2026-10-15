import { afterEach, describe, expect, it, vi } from "vitest";

import { mockModel } from "#evals/mock-model.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents } from "#internal/testing/events.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineMemory, type MemoryProvider } from "#public/memory/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

function memoryModule(recall: MemoryProvider["recall"]) {
  return {
    loadNamespace: async () => ({
      default: defineMemory({
        description: "Plants the person has told the agent about.",
        provider: { recall },
        scope: "test",
      }),
    }),
    logicalPath: "memory/plants.ts",
  };
}

/** Runs the session's first turn and returns its event types, cancelling the parked session. */
async function firstTurnEventTypes(runtime: TestRuntime, name: string): Promise<string[]> {
  return await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "My fern has brown tips." },
        serializedContext: {
          "eve.auth": null,
          "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
          "eve.channel": { kind: "http", state: {} },
          "eve.continuationToken": `http:${name}`,
          "eve.stateLayout": 1,
        },
      },
    ]);
    const stream = captureTurnEvents(run);
    const events = await stream.nextTurn().finally(() => stream.dispose());
    const types = events.map((event) => event.type);
    if (types.at(-1) === "session.waiting") await run.cancel();
    return types;
  });
}

// #4896: a recall error fails the turn once instead of escaping `turnStep` into step retries.
describe("memory recall failures", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails the turn once and keeps the session when turn.started recall throws", async () => {
    let recalls = 0;
    const runtime = await createTestRuntime({
      agent: { name: "turn-started-recall-failure" },
      modules: [
        memoryModule({
          "turn.started": async () => {
            recalls += 1;
            throw new Error("plant store is down");
          },
        }),
      ],
    });

    const types = await firstTurnEventTypes(runtime, "turn-started-recall-failure");

    expect(types.slice(-2)).toEqual(["turn.failed", "session.waiting"]);
    expect(recalls).toBe(1);
  });

  it("fails the turn once and keeps the session when compaction.completed recall throws", async () => {
    let recalls = 0;
    let summaries = 0;
    // Test runs swap authored models for a canned mock; this case scripts its own.
    vi.stubEnv("NODE_ENV", "development");
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          modelContextWindowTokens: 128_000,
          model: mockModel(({ messages, toolResults }) => {
            if (/checkpoint/i.test(messages[0]?.text ?? "")) {
              summaries += 1;
              return "Summary: the person's fern has brown tips and dry soil.";
            }
            if (toolResults.length === 0) {
              // Report most of the window so eve compacts before the next step.
              return {
                toolCalls: [{ name: "check_soil" }],
                usage: { inputTokens: 120_000, outputTokens: 10 },
              };
            }
            return "Water it when the top inch of soil is dry.";
          }),
        }),
        name: "compaction-recall-failure",
      },
      modules: [
        memoryModule({
          "turn.started": async () => null,
          "compaction.completed": async () => {
            recalls += 1;
            throw new Error("plant store is down");
          },
        }),
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Reads the soil moisture sensor.",
              inputSchema: { properties: {}, type: "object" },
              execute: async () => ({ moisture: "dry" }),
            }),
          }),
          logicalPath: "tools/check_soil.ts",
        },
      ],
    });

    const types = await firstTurnEventTypes(runtime, "compaction-recall-failure");

    expect(types.slice(-2)).toEqual(["turn.failed", "session.waiting"]);
    expect({ recalls, summaries }).toEqual({ recalls: 1, summaries: 1 });
  });
});
