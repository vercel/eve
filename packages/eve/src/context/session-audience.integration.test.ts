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

const CHILD_TASK = "Bob asks for the release notes.";

function lastUserText(prompt: LanguageModelV4Prompt): string {
  const user = prompt.filter((message) => message.role === "user").at(-1);
  if (user === undefined) return "";
  return user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs a turn whose model calls `lookup`, then the built-in `agent` tool, whose child calls
 * `lookup` too. Returns the audience every policy, tool, and hook call saw, root or child.
 */
async function audiencesSeen(name: string, audience?: "public" | "private") {
  const seen: string[] = [];
  const record = (
    where: string,
    ctx: { readonly session: { readonly audience: string; readonly parent?: unknown } },
  ) => {
    seen.push(
      `${ctx.session.parent === undefined ? "root" : "child"} ${where} ${ctx.session.audience}`,
    );
  };
  let settled = false;
  let step = 0;
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const child = lastUserText(prompt).includes(CHILD_TASK);
        const toolResults = prompt.filter((message) => message.role === "tool").length;
        if (child) {
          if (toolResults > 0) return textStreamResult("Notes are ready.");
          return toolCallStreamResult({ input: "{}", toolCallId: "child-1", toolName: "lookup" });
        }
        step++;
        if (step === 1)
          return toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "lookup" });
        if (step === 2)
          return toolCallStreamResult({
            input: JSON.stringify({ message: CHILD_TASK }),
            toolCallId: "call-2",
            toolName: "agent",
          });
        if (step === 3)
          return toolCallStreamResult({
            input: "{}",
            toolCallId: "call-3",
            toolName: "eve__task_wait",
          });
        return textStreamResult("Done.");
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        approval: (ctx) => {
          if (ctx.toolName === "lookup") record("policy", ctx);
          return undefined;
        },
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Look up release notes.",
            execute: (_input, ctx) => {
              record("tool", ctx);
              return { ok: true };
            },
            inputSchema: z.object({}),
          }),
        }),
        logicalPath: "tools/lookup.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "turn.started": (_event, ctx) => record("hook", ctx),
              "turn.settled": (_event, ctx) => {
                if (ctx.session.parent === undefined) settled = true;
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
        input: { message: "Alice asks for the release notes." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          ...(audience !== undefined && { audience }),
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
      },
    ]);
    try {
      await until(
        () => settled,
        () => `step ${step}, seen ${JSON.stringify(seen)}`,
      );
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return [...new Set(seen)].sort();
}

describe("ctx.session.audience", () => {
  it("is the session's classified audience in policies, tools, and hooks, and a subagent inherits it", async () => {
    expect(await audiencesSeen("audience-private", "private")).toEqual([
      "child hook private",
      "child policy private",
      "child tool private",
      "root hook private",
      "root policy private",
      "root tool private",
    ]);
  }, 90_000);

  it("is unknown when eve couldn't classify the conversation", async () => {
    expect(await audiencesSeen("audience-unknown")).toEqual([
      "child hook unknown",
      "child policy unknown",
      "child tool unknown",
      "root hook unknown",
      "root policy unknown",
      "root tool unknown",
    ]);
  }, 90_000);
});
