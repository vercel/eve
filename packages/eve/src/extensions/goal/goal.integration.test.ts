import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";

import extension from "./extension/extension.ts";
import judge from "./extension/hooks/judge.ts";
import instructions from "./extension/instructions.ts";
import type { GoalJudgeInput } from "./extension/lib/judge.ts";
import { goal } from "./extension/lib/state.ts";
import set from "./extension/tools/set.ts";
import status from "./extension/tools/status.ts";

// The goal loop end to end in one session: the model sets a goal, the judge keeps it going
// through the hook's ctx.continue(), and the session stops once the judge finds it met.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs a session where the model sets a goal, then calls `status` each continuation and replies
 * "Worked on the report.". Returns once `turns` turns settled.
 */
async function runGoalSession(name: string, turns: number) {
  const inputs: string[] = [];
  const systems: string[] = [];
  const settled: { readonly outcome: string; readonly goal: unknown }[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (prompt.at(-1)?.role === "tool") return textStreamResult("Worked on the report.");
        inputs.push(lastUserText(prompt));
        systems.push(JSON.stringify(prompt.filter((message) => message.role === "system")));
        return inputs.length === 1
          ? toolCallStreamResult({
              input: JSON.stringify({ objective: "Alice's report has a summary with numbers." }),
              toolCallId: "call-set",
              toolName: "set",
            })
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `call-status-${inputs.length}`,
              toolName: "status",
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
      { loadNamespace: async () => ({ default: set }), logicalPath: "tools/set.ts" },
      { loadNamespace: async () => ({ default: status }), logicalPath: "tools/status.ts" },
      {
        loadNamespace: async () => ({ default: instructions }),
        logicalPath: "instructions/goal.ts",
      },
      { loadNamespace: async () => ({ default: judge }), logicalPath: "hooks/judge.ts" },
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              // Runs after the judge's hook, so it reads the goal the verdict left.
              "turn.settled": (event) => {
                settled.push({ goal: goal.get(), outcome: event.data.outcome });
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
        input: { message: "Alice asks for her report, with a summary." },
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
      },
    ]);
    try {
      await until(
        () => settled.length >= turns,
        () => `settled ${JSON.stringify(settled)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { inputs, settled, systems };
}

describe("eve/extensions/goal", () => {
  it("continues the session until the judge finds the goal met", async () => {
    const judged: GoalJudgeInput[] = [];
    const verdicts = [
      { reason: "The report has no summary yet.", verdict: "continue" },
      { reason: "The summary is missing its numbers.", verdict: "continue" },
      { reason: "The report is complete.", verdict: "met" },
    ] as const;
    extension({
      judge: async (input) => {
        judged.push(input);
        return verdicts[judged.length - 1] ?? { reason: "Unexpected.", verdict: "impossible" };
      },
    });

    const { inputs, settled, systems } = await runGoalSession("goal", 3);

    expect(inputs).toEqual([
      "Alice asks for her report, with a summary.",
      "Continue working toward the goal. The report has no summary yet.",
      "Continue working toward the goal. The summary is missing its numbers.",
    ]);
    expect(settled.map(({ outcome }) => outcome)).toEqual(["completed", "completed", "completed"]);
    expect(settled.at(-1)?.goal).toMatchObject({ runs: 2, status: "met" });
    expect(judged.map(({ input }) => input)).toEqual(inputs);
    // The judge reads the turn's reply text.
    expect(judged.map(({ reply }) => reply)).toEqual(inputs.map(() => "Worked on the report."));
    expect(judged[0]?.objective).toBe("Alice's report has a summary with numbers.");
    expect(judged[0]?.calls.map(({ name }) => name)).toEqual(["set"]);
    // Continuations read the objective and the judge's last reason.
    expect(systems[1]).toContain("Alice's report has a summary with numbers.");
    expect(systems[2]).toContain("The summary is missing its numbers.");
  }, 90_000);

  it("pauses the goal when a judge throws before returning a promise", async () => {
    extension({
      judge: (() => {
        throw new Error("The judge isn't configured.");
      }) as never,
    });

    const { inputs, settled } = await runGoalSession("goal-judge-throws", 1);

    expect(inputs).toHaveLength(1);
    expect(settled[0]?.goal).toMatchObject({
      lastReason: "The goal judge failed.",
      status: "paused",
    });
  }, 90_000);
});
