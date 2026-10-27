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
import set from "./extension/tools/set.ts";
import status from "./extension/tools/status.ts";

// The goal loop end to end in one session: the model sets a goal, the judge keeps it going
// through the hook's ctx.followUp(), and the session stops once the judge finds it met.

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

    const inputs: string[] = [];
    const systems: string[] = [];
    const settled: string[] = [];
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
        name: "goal",
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
                "turn.settled": (event) => {
                  settled.push(event.data.outcome);
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
            continuationToken: "http:goal",
          }),
        },
      ]);
      try {
        await until(
          () => settled.length >= 3,
          () => `settled ${JSON.stringify(settled)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    expect(inputs).toEqual([
      "Alice asks for her report, with a summary.",
      "Continue working toward the goal. The report has no summary yet.",
      "Continue working toward the goal. The summary is missing its numbers.",
    ]);
    expect(settled).toEqual(["completed", "completed", "completed"]);
    expect(judged.map(({ input }) => input)).toEqual(inputs);
    expect(judged[0]?.objective).toBe("Alice's report has a summary with numbers.");
    expect(judged[0]?.calls.map(({ name }) => name)).toEqual(["set"]);
    // Continuations read the objective and the judge's last reason.
    expect(systems[1]).toContain("Alice's report has a summary with numbers.");
    expect(systems[2]).toContain("The summary is missing its numbers.");
  }, 90_000);
});
