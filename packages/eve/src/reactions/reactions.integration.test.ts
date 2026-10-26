import { deliveries } from "#protocol/session-projection/public-view.js";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";

import { defineDynamic } from "#dynamic/definition.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineMemory } from "#public/memory/index.js";
import { defineTool } from "#tools/definition.js";

// What each surface contributes, and when its memos and hooks run, read from what the model
// receives and what the definitions log, so the pins hold while the stream changes underneath.

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
  it("evaluates each surface before model calls, runs memos once per key, and acts on hook commands", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          // The memo chooses once per session; the provider object is built from its answer.
          model: defineDynamicModel(async (ctx) => {
            await ctx.memo(ctx.session.id, () => {
              log.push("memo:model");
              return "scripted";
            });
            return { model, modelContextWindowTokens: 200_000 };
          }),
        }),
        name: "reactions",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                capture: {
                  "compaction.requested": ({ compaction, messages, turn }) => {
                    log.push("capture:compaction");
                    log.push(`capture:compaction:turn:${String(turn?.id)}`);
                    log.push(`capture:compaction:model:${compaction.modelId}`);
                    log.push(`capture:compaction:history:${JSON.stringify(messages.map(textOf))}`);
                  },
                  "turn.completed": ({ turn }) => {
                    log.push("capture:turn");
                    log.push(`capture:input:${JSON.stringify(turn.input.map(textOf))}`);
                  },
                },
                recall: {
                  "turn.started": ({ turn }) => {
                    log.push("resolve:recall");
                    log.push(`recall:input:${JSON.stringify(turn.input.map(textOf))}`);
                    const content = `${RECALLED} (turn ${turn.sequence + 1})`;
                    return { messages: [{ content, id: "preference" }] };
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
            default: defineDynamic(() => {
              log.push("evaluate:tools");
              return {
                lookup: defineTool({
                  description: "Look something up.",
                  // Code a closure captures needs no durable descriptor.
                  execute: async () => ({ found: log.length > 0 }),
                  inputSchema: {},
                }),
              };
            }),
          }),
          logicalPath: "tools/lookup.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic(() => {
              log.push("evaluate:instructions");
              return defineInstructions({ content: POLICY });
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
                  const text = JSON.stringify(deliveries(ctx.view));
                  if (text.includes("[cancel]")) ctx.cancel("Asked to stop.");
                },
              },
            }),
          }),
          logicalPath: "hooks/gate.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "context.settled": (fact) => {
                  log.push(`context:${fact.data.kind}:${fact.data.outcome}`);
                },
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
        await resumeHook(inbox, { kind: "compact", deliveryId: "compact-second-turn" });
        await until(log, "context:compaction:completed", 1);
        await resumeHook(inbox, {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Look up the second thing." },
        });
        await until(log, "capture:turn", 2);
        await resumeHook(inbox, {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "[cancel] Look up a third thing." },
        });
        await until(log, "hook:turn", 3);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    // The model's memo runs once for the session, however many processes and model calls read it.
    expect(log.filter((entry) => entry === "memo:model")).toHaveLength(1);
    // Every model call evaluates the values again: two turns of two calls each. The third turn's
    // hook cancels it before it reaches one.
    expect(log.filter((entry) => entry === "evaluate:instructions").length).toBeGreaterThanOrEqual(
      4,
    );
    expect(log.filter((entry) => entry === "evaluate:tools").length).toBeGreaterThanOrEqual(4);
    expect(log.indexOf("evaluate:tools")).toBeLessThan(log.indexOf("call:turn"));
    // Recall runs before each turn's first model call, and every call reads it with the
    // instructions.
    expect(log.filter((entry) => entry === "resolve:recall")).toHaveLength(2);
    // Recall and capture both see the turn's own input.
    expect(log).toContain(`recall:input:${JSON.stringify(["Look up the first thing."])}`);
    expect(log).toContain(`capture:input:${JSON.stringify(["Look up the first thing."])}`);
    for (const prompt of prompts) {
      expect(JSON.stringify(prompt)).toContain(RECALLED);
      expect(JSON.stringify(prompt)).toContain(POLICY);
    }
    // Each turn's recall sits just ahead of its input, so a continuation extends the call before
    // it. A recall with the same id replaces the earlier turn's.
    const texts = (prompt: LanguageModelV4Prompt) =>
      prompt.flatMap((message) =>
        message.role === "user"
          ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      );
    expect(texts(prompts[0]!).slice(-2)).toEqual([
      `${RECALLED} (turn 1)`,
      "Look up the first thing.",
    ]);
    expect(prompts[1]!.slice(0, prompts[0]!.length)).toEqual(prompts[0]);
    expect(texts(prompts[2]!).slice(-2)).toEqual([
      `${RECALLED} (turn 2)`,
      "Look up the second thing.",
    ]);
    expect(JSON.stringify(prompts[2])).not.toContain("(turn 1)");
    // The tool the reaction returned ran, and the model read its result.
    expect(JSON.stringify(prompts[1])).toContain('"found":true');

    // An explicit session compaction ran once before the second turn's first model call.
    const secondTurn = log.slice(log.indexOf("capture:turn") + 1, log.lastIndexOf("capture:turn"));
    expect(log.filter((entry) => entry === "call:summary")).toHaveLength(1);
    expect(secondTurn.indexOf("call:summary")).toBeLessThan(secondTurn.indexOf("call:turn"));

    // Capture before compaction read the history the summary rewrote, before the summary ran.
    expect(log.filter((entry) => entry === "capture:compaction")).toHaveLength(1);
    expect(log.indexOf("capture:compaction")).toBeLessThan(log.indexOf("call:summary"));
    expect(log).toContain("capture:compaction:model:eve-test/scripted-model");
    const captured = log.find((entry) => entry.startsWith("capture:compaction:history:"))!;
    expect(captured).toContain("Look up the first thing.");

    // The third turn's hook cancelled it before its model call.
    expect(prompts.map(lastUserText).some((text) => text.includes("[cancel]"))).toBe(false);
  }, 90_000);

  it("fails a compaction whose memory capture throws, and keeps the history", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({ model, modelContextWindowTokens: 200_000 } as never),
        name: "capture-fails",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                capture: {
                  "compaction.requested": () => {
                    log.push("capture:compaction");
                    throw new Error("The store is down.");
                  },
                },
                recall: { "turn.started": () => null },
              },
              scope: "test",
            }),
          }),
          logicalPath: "memory/notes.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic(() => ({
              lookup: defineTool({
                description: "Look something up.",
                execute: async () => ({ found: true }),
                inputSchema: {},
              }),
            })),
          }),
          logicalPath: "tools/lookup.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "context.settled": (fact) => {
                  log.push(`context:${fact.data.kind}:${fact.data.outcome}`);
                },
                "turn.settled": (fact) => {
                  log.push(`turn:${fact.data.outcome}`);
                },
              },
            }),
          }),
          logicalPath: "hooks/observe.ts",
        },
      ],
    });
    const continuationToken = "http:capture-fails";

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
        await until(log, "turn:completed", 1);
        await resumeHook(inbox, { kind: "compact", deliveryId: "compact-fails" });
        await until(log, "context:compaction:failed", 1);
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    // The capture threw before the summary, so no summary ran and the compaction failed.
    expect(log.filter((entry) => entry === "capture:compaction")).toHaveLength(1);
    expect(log).not.toContain("call:summary");
    expect(log).not.toContain("context:compaction:completed");
  }, 90_000);

  it("finishes a compaction that a cancel arrives during, and ignores the cancel", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({ model, modelContextWindowTokens: 200_000 } as never),
        name: "cancel-during-compaction",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                capture: {
                  "compaction.requested": async () => {
                    log.push("capture:compaction");
                    await released;
                  },
                },
                recall: { "turn.started": () => null },
              },
              scope: "test",
            }),
          }),
          logicalPath: "memory/notes.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic(() => ({
              lookup: defineTool({
                description: "Look something up.",
                execute: async () => ({ found: true }),
                inputSchema: {},
              }),
            })),
          }),
          logicalPath: "tools/lookup.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "context.settled": (fact) => {
                  log.push(`context:${fact.data.kind}:${fact.data.outcome}`);
                },
                "delivery.settled": (fact) => {
                  log.push(`settled:${fact.data.deliveryId}:${fact.data.outcome}`);
                },
                "turn.settled": (fact) => {
                  log.push(`turn:${fact.data.outcome}`);
                },
              },
            }),
          }),
          logicalPath: "hooks/observe.ts",
        },
      ],
    });
    const continuationToken = "http:cancel-during-compaction";

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
        await until(log, "turn:completed", 1);
        await resumeHook(inbox, { kind: "compact", deliveryId: "compact" });
        await until(log, "capture:compaction", 1);
        // Alice cancels while the compaction is still capturing memory.
        await resumeHook(inbox, { kind: "cancel", deliveryId: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 200));
        release();
        await until(log, "settled:cancel:ignored", 1);
        await until(log, "settled:compact:applied", 1);
      } finally {
        release();
        await run.cancel().catch(() => {});
      }
    });

    expect(log).toContain("context:compaction:completed");
  }, 90_000);

  it("gives memory tools the scope recall resolved for the same turn", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    // Alice moves to another thread between turns; a scope that follows the thread changes too.
    let thread = "thread-1";
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({ model, modelContextWindowTokens: 200_000 } as never),
        name: "memory-scope",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                recall: {
                  "turn.started": ({ memory }) => {
                    log.push(`recall:${JSON.stringify(memory.scope)}`);
                    return null;
                  },
                },
                tools: async ({ memory }) => {
                  log.push(`tools:${JSON.stringify(memory.scope)}`);
                  return {
                    lookup: defineTool({
                      description: "Look something up.",
                      execute: async () => ({ found: true }),
                      inputSchema: {},
                    }),
                  };
                },
              },
              scope: () => thread,
            }),
          }),
          logicalPath: "memory/notes.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "turn.settled": () => {
                  log.push("turn:settled");
                },
              },
            }),
          }),
          logicalPath: "hooks/observe.ts",
        },
      ],
    });
    const continuationToken = "http:memory-scope";

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
        await until(log, "turn:settled", 1);
        thread = "thread-2";
        await resumeHook(inbox, {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Look up the second thing." },
        });
        await until(log, "turn:settled", 2);
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    // Each turn's tools use the scope that turn's recall used.
    const turns = [
      log.slice(0, log.indexOf("turn:settled")),
      log.slice(log.indexOf("turn:settled")),
    ];
    for (const [index, entries] of turns.entries()) {
      const recalled = entries.filter((entry) => entry.startsWith("recall:"));
      expect(recalled).toHaveLength(1);
      expect(recalled[0]).toContain(`thread-${index + 1}`);
      const tools = entries.filter((entry) => entry.startsWith("tools:"));
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((entry) => entry.slice("tools:".length))).toEqual(
        tools.map(() => recalled[0]!.slice("recall:".length)),
      );
    }
  }, 90_000);

  it("runs a ctx.agent model override instead of the agent's dynamic model", async () => {
    const log: string[] = [];
    const started: string[] = [];
    const model = scriptedModel(log, []);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamicModel(() => {
            log.push("model:selected");
            return { model, modelContextWindowTokens: 200_000 };
          }),
        } as never),
        name: "overridden",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineHook({
              events: {
                "model.started": (event: { readonly data: { readonly modelId: string } }) => {
                  started.push(event.data.modelId);
                },
                "turn.settled": () => {
                  log.push("turn:settled");
                },
              },
            } as never),
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
          input: { message: "Alice asks Bob's researcher for a summary." },
          serializedContext: {
            ...buildSerializedContext({
              auth: ALICE,
              channelKind: "http",
              continuationToken: "http:overridden",
            }),
            "eve.agentSessionRuntimeOverrides": {
              model: { contextWindowTokens: 200_000, id: "openai/gpt-6.1-sol" },
            },
          },
        },
      ]);
      try {
        await until(log, "turn:settled", 1);
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    expect(started).toEqual(["openai/gpt-6.1-sol"]);
    expect(log).not.toContain("model:selected");
    expect(log).not.toContain("call:turn");
  }, 90_000);

  describe("across deployments", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("runs memos again on a new deployment", async () => {
      const log: string[] = [];
      const prompts: LanguageModelV4Prompt[] = [];
      const model = scriptedModel(log, prompts);
      vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_first");
      const runtime = await createTestRuntime({
        agent: {
          definition: defineAgent({ model, modelContextWindowTokens: 200_000 } as never),
          name: "deployments",
        },
        modules: [
          {
            loadNamespace: async () => ({
              default: defineDynamic(async (ctx) => {
                const content = await ctx.memo(ctx.session.id, () => {
                  log.push(`memo:policy:${process.env.VERCEL_DEPLOYMENT_ID}`);
                  return POLICY;
                });
                return defineInstructions({ content });
              }),
            }),
            logicalPath: "instructions/policy.ts",
          },
          {
            loadNamespace: async () => ({
              default: defineDynamic(() => ({
                lookup: defineTool({
                  description: "Look something up.",
                  execute: async () => ({ found: true }),
                  inputSchema: {},
                }),
              })),
            }),
            logicalPath: "tools/lookup.ts",
          },
          {
            loadNamespace: async () => ({
              default: defineHook({
                events: {
                  "turn.settled": () => {
                    log.push("turn:settled");
                  },
                },
              }),
            }),
            logicalPath: "hooks/observe.ts",
          },
        ],
      });
      const continuationToken = "http:deployments";

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
          await until(log, "turn:settled", 1);
          // The idle session's next step runs on another deployment.
          vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_second");
          await resumeHook(inbox, {
            auth: ALICE,
            delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
            kind: "send",
            payload: { message: "Look up the second thing." },
          });
          await until(log, "turn:settled", 2);
        } finally {
          await run.cancel().catch(() => {});
        }
      });

      // The session-keyed memo runs once per deployment, and every call still reads it.
      expect(log.filter((entry) => entry.startsWith("memo:policy:"))).toEqual([
        "memo:policy:dpl_first",
        "memo:policy:dpl_second",
      ]);
      for (const prompt of prompts) expect(JSON.stringify(prompt)).toContain(POLICY);
    }, 90_000);
  });
});
