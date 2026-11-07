import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";

import extension from "./extension/extension.ts";
import detect from "./extension/hooks/detect.ts";
import instructions from "./extension/instructions.ts";
import { loops } from "./extension/lib/state.ts";

// A model stuck on one failing call, end to end in one session: the extension nudges it through
// the system prompt, then stops the turn once the loop comes back, long before the step limit.

const NUDGE = "The last 3 calls to `read_file` used the same input and returned the same result.";

function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs one turn where the model reads `missing.txt` on every call for up to `maxCalls` calls, then
 * replies. Returns each model call's system prompt, how often the tool ran, and how the turn
 * settled.
 */
async function runStuckSession(name: string, maxCalls: number) {
  const systems: string[] = [];
  const settled: { readonly outcome: string; readonly state: unknown }[] = [];
  let executions = 0;
  const readFile = defineTool({
    description: "Read a file.",
    inputSchema: z.object({ path: z.string() }),
    execute: () => {
      executions++;
      return { error: "File not found." };
    },
  });
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        systems.push(systemText(prompt));
        if (systems.length > maxCalls) return textStreamResult("Alice's file isn't there.");
        return toolCallStreamResult({
          input: JSON.stringify({ path: "missing.txt" }),
          toolCallId: `call-${systems.length}`,
          toolName: "read_file",
        });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      { loadNamespace: async () => ({ default: readFile }), logicalPath: "tools/read_file.ts" },
      {
        loadNamespace: async () => ({ default: instructions }),
        logicalPath: "instructions/loops.ts",
      },
      { loadNamespace: async () => ({ default: detect }), logicalPath: "hooks/detect.ts" },
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "turn.settled": (event) => {
                settled.push({ outcome: event.data.outcome, state: loops.get() });
              },
            },
          }),
        }),
        logicalPath: "hooks/observe.ts",
      },
    ],
  });

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Alice asks for a summary of missing.txt." },
        serializedContext: buildSerializedContext({
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
      },
    ]);
    try {
      await until(
        () => settled.length >= 1,
        () => `systems ${systems.length}, executions ${executions}`,
      );
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { executions, settled, systems };
}

describe("eve/extensions/loops", () => {
  it("nudges a stuck turn after three repeats, then stops it after three more", async () => {
    extension({});

    const { executions, settled, systems } = await runStuckSession("loops", 50);

    expect(executions).toBe(6);
    // The model is called once per tool call; the stop lands before a seventh call.
    expect(systems).toHaveLength(6);
    expect(systems.slice(0, 3).some((system) => system.includes(NUDGE))).toBe(false);
    for (const system of systems.slice(3)) expect(system).toContain(NUDGE);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toBe("cancelled");
    expect(settled[0]?.state).toMatchObject({ nudges: 1 });
  }, 90_000);

  it("stops at the first loop when maxNudges is 0", async () => {
    extension({ maxNudges: 0 });

    const { executions, settled, systems } = await runStuckSession("loops-stop", 50);

    expect(executions).toBe(3);
    expect(systems.some((system) => system.includes(NUDGE))).toBe(false);
    expect(settled[0]?.outcome).toBe("cancelled");
  }, 90_000);

  it("leaves a turn that stops repeating on its own alone", async () => {
    extension({});

    const { executions, settled, systems } = await runStuckSession("loops-recovers", 2);

    expect(executions).toBe(2);
    expect(systems).toHaveLength(3);
    expect(systems.some((system) => system.includes(NUDGE))).toBe(false);
    expect(settled[0]).toMatchObject({ outcome: "completed", state: { nudges: 0 } });
  }, 90_000);
});
