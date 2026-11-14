import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { defineDynamic } from "#dynamic/definition.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

// The bench agent: a model that answers at once and a tool that does nothing, so what a turn
// costs is the host's. A message asks for its tool calls by count, and the model makes them one
// per model call, so a turn with N calls is N + 1 model steps.

const MARKER = "bench:";
export const BENCH_TOOL = "noop";

/** A bench message that asks the model for `tools` sequential tool calls before it answers. */
export function benchMessage(text: string, tools = 0): string {
  return `${MARKER} ${text}${tools > 0 ? ` [tools:${tools}]` : ""}`;
}

function textOf(message: LanguageModelV4Prompt[number]): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as readonly { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

/** What the model answers: the next tool call the latest bench message asks for, or its reply. */
function respond(prompt: LanguageModelV4Prompt, nextCallId: () => string) {
  const asked = prompt.findLastIndex(
    (message) => message.role === "user" && textOf(message).includes(MARKER),
  );
  const wanted = Number(/\[tools:(\d+)\]/u.exec(textOf(prompt[asked] ?? prompt[0]!))?.[1] ?? 0);
  const done = prompt
    .slice(asked + 1)
    .filter((message) => message.role === "tool")
    .reduce(
      (count, message) =>
        count +
        (message.content as { type: string }[]).filter((p) => p.type === "tool-result").length,
      0,
    );
  return done < wanted
    ? toolCallsStreamResult([{ input: "{}", toolCallId: nextCallId(), toolName: BENCH_TOOL }])
    : textStreamResult("Done.");
}

/** Compiles the bench agent under `name`. */
export async function createBenchAgent(name: string): Promise<TestRuntime> {
  let calls = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => respond(prompt, () => `call_${++calls}`),
      modelId: name,
      provider: "eve-test",
    }),
  );
  return await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Does nothing and returns at once.",
            execute: async () => ({ ok: true }),
            inputSchema: z.object({}).passthrough(),
          }),
        }),
        logicalPath: `tools/${BENCH_TOOL}.ts`,
      },
    ],
  });
}
