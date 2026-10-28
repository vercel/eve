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

import instructions from "./extension/instructions.ts";
import { todos } from "./extension/lib/state.ts";
import write from "./extension/tools/write.ts";

// The checklist end to end in one turn: the model writes it, sees it on the next model call,
// finishes it, and stops seeing it.

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

describe("eve/extensions/todo", () => {
  it("shows the checklist while work is open and hides it once finished", async () => {
    const open = [
      { content: "Read Alice's report", status: "in_progress" },
      { content: "Send the summary to Bob", status: "pending" },
    ];
    const done = open.map((item) => ({ ...item, status: "completed" }));
    const systems: string[] = [];
    const settled: { readonly outcome: string; readonly todos: unknown }[] = [];
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          systems.push(systemText(prompt));
          if (systems.length === 1) {
            return toolCallStreamResult({
              input: JSON.stringify({ todos: open }),
              toolCallId: "call-open",
              toolName: "write",
            });
          }
          if (systems.length === 2) {
            return toolCallStreamResult({
              input: JSON.stringify({ todos: done }),
              toolCallId: "call-done",
              toolName: "write",
            });
          }
          return textStreamResult("Sent Bob the summary.");
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
        name: "todo",
      },
      modules: [
        { loadNamespace: async () => ({ default: write }), logicalPath: "tools/write.ts" },
        {
          loadNamespace: async () => ({ default: instructions }),
          logicalPath: "instructions/todo.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.settled": (event) => {
                  settled.push({ outcome: event.data.outcome, todos: todos.get() });
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
          input: { message: "Alice asks for her report to be summarized for Bob." },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:todo",
          }),
        },
      ]);
      try {
        await until(
          () => settled.length >= 1,
          () => `systems ${JSON.stringify(systems)}`,
        );
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    expect(systems).toHaveLength(3);
    expect(systems[0]).not.toContain("<todos>");
    expect(systems[1]).toContain(
      "<todos>\n[>] Read Alice's report\n[ ] Send the summary to Bob\n</todos>",
    );
    expect(systems[2]).not.toContain("<todos>");
    expect(settled).toEqual([{ outcome: "completed", todos: done }]);
  }, 90_000);
});
