import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineDynamic } from "#dynamic/definition.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { cancel, compact, defineHook } from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineMemory } from "#public/memory/index.js";
import { defineTool } from "#tools/definition.js";

// What each surface contributes, and when its `resolve` runs, read from what the model receives
// and what the reactions log, so the pins hold while the stream changes underneath them.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const RECALLED = "Recalled: Alice prefers short answers.";
const POLICY = "Answer in one sentence.";

function isSummaryRequest(prompt: LanguageModelV4Prompt): boolean {
  return JSON.stringify(prompt).includes("CONTEXT CHECKPOINT COMPACTION");
}

function textOf(message: { readonly content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as readonly { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

/** Each turn calls `lookup` once and then replies; a compaction gets a summary. */
function scriptedModel(log: string[], prompts: LanguageModelV4Prompt[]) {
  const summary = () => {
    log.push("call:summary");
    return textStreamResult("Alice asked for lookups.");
  };
  return markMockModel(
    new MockLanguageModelV4({
      doGenerate: async () => {
        log.push("call:summary");
        return {
          content: [{ text: "Alice asked for lookups.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
          warnings: [],
        };
      },
      doStream: async ({ prompt }) => {
        if (isSummaryRequest(prompt)) return summary();
        log.push("call:turn");
        prompts.push(prompt);
        return prompt.at(-1)?.role === "tool"
          ? textStreamResult("Done.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `call-${log.length}`,
              toolName: "lookup",
            });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
}

async function until(log: readonly string[], entry: string, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (log.filter((value) => value === entry).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count}× "${entry}". Log: ${log.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("reactions", () => {
  it("resolves each surface when its selection changes, and acts on hook intents", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineDynamic({
          select: () => null,
          resolve: () => {
            log.push("resolve:model");
            return defineAgent({ model, modelContextWindowTokens: 200_000 });
          },
        }) as never,
        name: "reactions",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                capture: {
                  "turn.completed": ({ turn }) => {
                    log.push("capture:turn");
                    log.push(`capture:input:${JSON.stringify(turn.input.map(textOf))}`);
                  },
                },
                recall: {
                  "turn.started": ({ turn }) => {
                    log.push("resolve:recall");
                    log.push(`recall:input:${JSON.stringify(turn.input.map(textOf))}`);
                    return { messages: [{ content: RECALLED }] };
                  },
                },
              },
              scope: "test",
            }),
          }),
          logicalPath: "memory/notes.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic({
              select: (view) => view.latest["turn.started"] ?? null,
              resolve: () => {
                log.push("resolve:tools");
                return {
                  lookup: defineTool({
                    description: "Look something up.",
                    // Code a closure captures needs no durable descriptor.
                    execute: async () => ({ found: log.length > 0 }),
                    inputSchema: {},
                  }),
                };
              },
            }),
          }),
          logicalPath: "tools/lookup.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic({
              select: () => null,
              resolve: () => {
                log.push("resolve:instructions");
                return defineInstructions({ content: POLICY });
              },
            }),
          }),
          logicalPath: "instructions/policy.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.started": (_fact, ctx) => {
                  log.push("hook:turn");
                  const text = JSON.stringify(ctx.view.deliveries);
                  return text.includes("[cancel]") ? cancel("Asked to stop.") : null;
                },
              },
            }),
          }),
          logicalPath: "hooks/gate.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              select: (view) => view.session.turnCount >= 2,
              resolve: (second) => {
                log.push(`hook:compact:${String(second)}`);
                return second ? compact("second-turn") : null;
              },
            }),
          }),
          logicalPath: "hooks/compactor.ts",
        },
      ],
    });
    const continuationToken = "http:reactions";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Look up the first thing." },
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken,
          }),
        },
      ]);
      const inbox = sessionInboxHookToken(continuationToken);
      try {
        await until(log, "capture:turn", 1);
        await resumeHook(inbox, {
          auth: ALICE,
          kind: "send",
          payload: { message: "Look up the second thing." },
        });
        await until(log, "capture:turn", 2);
        await resumeHook(inbox, {
          auth: ALICE,
          kind: "send",
          payload: { message: "[cancel] Look up a third thing." },
        });
        await until(log, "hook:turn", 3);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    // Without a select, the agent and the instructions resolve once for the session.
    expect(log.filter((entry) => entry === "resolve:model")).toHaveLength(1);
    expect(log.filter((entry) => entry === "resolve:instructions")).toHaveLength(1);
    // Tools select the latest turn start: once before the first turn, then once per turn, before
    // its first call.
    expect(log.filter((entry) => entry === "resolve:tools")).toHaveLength(4);
    expect(log.indexOf("resolve:tools")).toBeLessThan(log.indexOf("call:turn"));
    // Recall runs after each turn starts, and every model call reads it with the instructions.
    expect(log.filter((entry) => entry === "resolve:recall")).toHaveLength(3);
    // Recall and capture both see the turn's own input.
    expect(log).toContain(`recall:input:${JSON.stringify(["Look up the first thing."])}`);
    expect(log).toContain(`capture:input:${JSON.stringify(["Look up the first thing."])}`);
    for (const prompt of prompts) {
      expect(JSON.stringify(prompt)).toContain(RECALLED);
      expect(JSON.stringify(prompt)).toContain(POLICY);
    }
    // The tool the reaction returned ran, and the model read its result.
    expect(JSON.stringify(prompts[1])).toContain('"found":true');

    // The compact intent compacted once, before the second turn's first model call.
    const secondTurn = log.slice(log.indexOf("capture:turn") + 1, log.lastIndexOf("capture:turn"));
    expect(log.filter((entry) => entry === "call:summary")).toHaveLength(1);
    expect(secondTurn.indexOf("call:summary")).toBeLessThan(secondTurn.indexOf("call:turn"));
    expect(log.filter((entry) => entry === "hook:compact:true")).toHaveLength(1);

    // The third turn's hook cancelled it before its model call.
    expect(prompts.map(lastUserText).some((text) => text.includes("[cancel]"))).toBe(false);
  }, 90_000);
});
