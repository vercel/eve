import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext, withTimeout } from "#internal/testing/entry-test-helpers.js";
import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import {
  sessionCommandHookToken,
  sessionInboxHookToken,
} from "#execution/session-inbox/address.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { always } from "#tools/approval/policies.js";
import {
  captureTurnEvents,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { summarizeTurnEvents } from "#client/session-utils.js";
import { startSessionOwner } from "#internal/testing/workflow-test-helpers.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHarness, type Harness } from "#public/definitions/harness.js";
import { builtins, declared } from "#harness/policy/agent.js";
import { defineDynamic } from "#public/definitions/model.js";
import {
  defineDynamic as defineDynamicInstructions,
  defineInstructions,
} from "#public/definitions/instructions.js";
import { defineTool } from "#tools/definition.js";
import { defineDynamic as defineDynamicTools } from "#tools/dynamic.js";
import { recordUsage } from "#harness/usage-sink.js";
import type { SessionEvent } from "#protocol/session-event.js";

// `agent/harness.ts`, compiled and run: what its `agent` fields add to a model call, and how its
// `next` continues a turn.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

type Respond = (options: LanguageModelV4CallOptions) => ReturnType<typeof textStreamResult>;

function model(modelId: string, respond: Respond) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async (options) => respond(options),
      modelId,
      provider: "openai",
    }),
  );
}

async function firstReply(input: Parameters<typeof firstTurn>[0]): Promise<string | null> {
  return (await firstTurn(input)).reply;
}

async function firstTurn(input: {
  readonly harness: Harness | { readonly invalid: true } | undefined;
  readonly model: ReturnType<typeof model>;
  readonly message: string;
  /** The agent's other files. */
  readonly modules?: NonNullable<Parameters<typeof createTestRuntime>[0]>["modules"];
}): Promise<{ readonly reply: string | null; readonly events: readonly SessionEvent[] }> {
  const runtime = await createTestRuntime({
    agent: {
      // Tests replace a static model with eve's mock; a dynamic one keeps the scripted model.
      definition: defineAgent({
        model: defineDynamic(() => ({ model: input.model, modelContextWindowTokens: 200_000 })),
      }),
      name: "harness-probe",
    },
    modules: [
      ...(input.modules ?? []),
      ...(input.harness === undefined
        ? []
        : [
            {
              loadNamespace: async () => ({
                default: typeof input.harness === "function" ? defineHarness(input.harness) : {},
              }),
              logicalPath: "harness.ts",
            },
          ]),
    ],
  });
  return await runtime.run(async () => {
    const run = await startSessionOwner(workflowEntry, [
      {
        input: { message: input.message },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          channelKind: "http",
          continuationToken: `http:harness-${Math.random()}`,
        }),
      },
    ]);
    const stream = captureTurnEvents(run);
    try {
      const events = await withTimeout(stream.nextTurn(), "turn");
      return { events, reply: summarizeTurnEvents(events).message ?? null };
    } finally {
      stream.dispose();
      await run.cancel();
    }
  });
}

const tool = (description: string) =>
  defineTool({ description, execute: async () => ({}), inputSchema: {} });

const systemOf = (options: LanguageModelV4CallOptions) =>
  options.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");

const lastText = (options: LanguageModelV4CallOptions) => {
  const last = options.prompt.at(-1);
  if (last?.role !== "user") return "";
  return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
};

describe.each([
  { cold: false, name: "agent/harness.ts" },
  { cold: true, name: "agent/harness.ts, every step a fresh process" },
])("$name", ({ cold }) => {
  beforeEach(() => {
    if (cold) vi.stubEnv("EVE_REACTIONS_COLD", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds its instructions and tools to the model call, and continues the turn with a note", async () => {
    const lookups: string[] = [];
    const fetches: string[] = [];
    const seen: unknown[] = [];
    const calls: { readonly system: string; readonly tools: readonly string[] }[] = [];
    const lastMessages: string[] = [];
    const { reply, events } = await firstTurn({
      harness: (ctx) => ({
        agent: {
          instructions: "Alice's account is on the Pro plan.",
          tools: async () => ({
            plan_lookup: defineTool({
              description: await ctx.memo(["plan", ctx.turn?.id ?? null], () => {
                fetches.push("plan");
                return "Look up what Alice's plan includes.";
              }),
              execute: async () => {
                lookups.push("plan_lookup");
                await recordUsage({ inputTokens: 40, outputTokens: 8 });
                return { seats: 10 };
              },
              inputSchema: {},
            }),
          }),
        },
        next: () => {
          seen.push({
            calls: ctx.calls.map((call) => `${call.tool}:${call.status}`),
            steps: ctx.steps,
          });
          return ctx.continuations === 0 && ctx.lastStep?.text?.includes("[1]") === false
            ? { model: { note: "Cite the lookup as [1]." } }
            : undefined;
        },
      }),
      message: "How many seats does Alice have?",
      model: model("gpt-5.5", (options) => {
        calls.push({
          system: systemOf(options),
          tools: (options.tools ?? []).map((tool) => tool.name),
        });
        lastMessages.push(lastText(options));
        if (options.prompt.at(-1)?.role !== "tool" && lastText(options).includes("Cite")) {
          return textStreamResult("Alice has 10 seats [1].");
        }
        if (options.prompt.at(-1)?.role === "tool") return textStreamResult("Alice has 10 seats.");
        return toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "plan_lookup" });
      }),
    });

    expect(reply).toBe("Alice has 10 seats [1].");
    expect(lookups).toEqual(["plan_lookup"]);
    // What the tool's own model use spent counts, against its call.
    expect(
      events.filter((event) => event.type === "usage.recorded" && event.data.kind === "auxiliary"),
    ).toMatchObject([
      { data: { owner: { callId: "call-1" }, usage: { inputTokens: 40, outputTokens: 8 } } },
    ]);
    // Three model calls, one lookup: the memo keeps it, in a fresh process too.
    expect(fetches).toEqual(["plan"]);
    // At the start, before the model reads the lookup, and after each answer.
    expect(seen).toEqual([
      { calls: [], steps: 0 },
      { calls: ["plan_lookup:settled"], steps: 1 },
      { calls: ["plan_lookup:settled"], steps: 2 },
      { calls: ["plan_lookup:settled"], steps: 3 },
    ]);
    expect(calls).toHaveLength(3);
    // The turn's input joined history before the harness decided; eve's context still goes ahead
    // of it, so the model reads Alice's message last.
    expect(lastMessages[0]).toBe("How many seats does Alice have?");
    expect(calls[0]!.system).toContain("Alice's account is on the Pro plan.");
    expect(calls[0]!.tools).toContain("plan_lookup");
  });

  it("runs its tool after the call's approval, in a later step", async () => {
    const runs: string[] = [];
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({
            model: model("gpt-5.5", (options) =>
              options.prompt.at(-1)?.role === "tool"
                ? textStreamResult("Refunded.")
                : toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "refund" }),
            ),
            modelContextWindowTokens: 200_000,
          })),
        }),
        name: "harness-approval",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineHarness(() => ({
              agent: {
                tools: {
                  refund: defineTool({
                    approval: { request: always(), response: () => ({ status: "allowed" }) },
                    description: "Refund Alice's last order.",
                    execute: async () => {
                      runs.push("refund");
                      return { refunded: true };
                    },
                    inputSchema: {},
                  }),
                },
              },
            })),
          }),
          logicalPath: "harness.ts",
        },
      ],
    });
    const continuationToken = `http:harness-approval-${cold}`;
    const stages = await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          input: { message: "Refund Alice's last order." },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: {
            ...buildSerializedContext({ auth: ALICE, channelKind: "http", continuationToken }),
            "eve.capabilities": { requestInput: true },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const paused = await withTimeout(stream.nextTurn(), "approval");
        const [opened] = filterEventsByType(paused, "interaction.opened");
        await resumeHook(sessionInboxHookToken(sessionCommandHookToken(run.runId)), {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: {
            answers: [{ interactionId: opened!.data.interactionId, optionId: "approve" }],
          },
        });
        return [paused, await withTimeout(stream.nextTurn(), "approved")];
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(runs).toEqual(["refund"]);
    expect(summarizeTurnEvents(stages[1]!).message).toBe("Refunded.");
  });

  it("offers only the tools it returns, from what the agent declares, and skips the agent's model when it picks one", async () => {
    const offered: string[][] = [];
    const agentModelRuns: string[] = [];
    const scripted = model("gpt-5.5", (options) => {
      offered.push((options.tools ?? []).map((tool) => tool.name));
      return textStreamResult("Done.");
    });
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => {
            agentModelRuns.push("agent");
            return { model: scripted, modelContextWindowTokens: 200_000 };
          }),
        }),
        name: "harness-tools",
      },
      modules: [
        {
          loadNamespace: async () => ({ default: tool("Search the docs.") }),
          logicalPath: "tools/search.ts",
        },
        {
          loadNamespace: async () => ({ default: tool("Delete Alice's account.") }),
          logicalPath: "tools/delete_account.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHarness((ctx) => ({
              agent: {
                model: { model: scripted, modelContextWindowTokens: 200_000 },
                tools: async () => {
                  const {
                    bash: _bash,
                    delete_account: _deleted,
                    ...tools
                  } = (await declared(ctx)).tools;
                  return { ...tools, ...builtins(ctx).tools, plan_lookup: tool("Look up a plan.") };
                },
              },
            })),
          }),
          logicalPath: "harness.ts",
        },
      ],
    });
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          input: { message: "What can you do?" },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: `http:harness-tools-${cold}`,
          }),
        },
      ]);
      return await readFirstTurnReply(run);
    });

    expect(offered).toHaveLength(1);
    expect(offered[0]).toEqual(expect.arrayContaining(["plan_lookup", "read_file", "search"]));
    expect(offered[0]).not.toContain("delete_account");
    expect(offered[0]).not.toContain("bash");
    expect(agentModelRuns).toEqual([]);
  });

  it("reads only the declared instructions it keeps", async () => {
    const systems: string[] = [];
    const scripted = model("gpt-5.5", (options) => {
      systems.push(systemOf(options));
      return textStreamResult("Done.");
    });
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model: scripted, modelContextWindowTokens: 200_000 })),
        }),
        name: "harness-instructions",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineDynamicInstructions(() =>
              defineInstructions({ content: "Write in house style." }),
            ),
          }),
          logicalPath: "instructions/house-style.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamicInstructions(() =>
              defineInstructions({ content: "Mention the roadmap." }),
            ),
          }),
          logicalPath: "instructions/roadmap.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineHarness((ctx) => ({
              agent: {
                instructions: async () => [
                  (await declared(ctx)).instructions["house-style"]!.content,
                  "Answer billing questions.",
                ],
              },
            })),
          }),
          logicalPath: "harness.ts",
        },
      ],
    });
    await runtime.run(async () => {
      const run = await startSessionOwner(workflowEntry, [
        {
          input: { message: "What can you do?" },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: `http:harness-instructions-${cold}`,
          }),
        },
      ]);
      return await readFirstTurnReply(run);
    });

    // Exactly what the harness returns: no agent instructions, workspace, or skills of eve's.
    expect(systems).toEqual(["Write in house style.\n\nAnswer billing questions."]);
  });

  it("reproduces eve's prompt and tools when it composes what eve composes", async () => {
    const calls: { system: string; tools: unknown; messages: unknown }[] = [];
    const scripted = model("gpt-5.5", (options) => {
      calls.push({
        // The rest of the prompt, with eve's announcement of the catalog.
        messages: options.prompt.filter((message) => message.role !== "system"),
        system: systemOf(options),
        tools: (options.tools ?? []).map((entry) => ({
          description: "description" in entry ? entry.description : undefined,
          name: entry.name,
        })),
      });
      return textStreamResult("Done.");
    });
    const modules = [
      {
        loadNamespace: async () => ({ default: tool("Search the docs.") }),
        logicalPath: "tools/search.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineTool({
            deferred: true,
            description: "Export Alice's rows.",
            execute: async () => ({}),
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/export_rows.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineDynamicInstructions(() =>
            defineInstructions({ content: "Write in house style." }),
          ),
        }),
        logicalPath: "instructions/house-style.ts",
      },
    ];
    await firstTurn({ harness: undefined, message: "What can you do?", model: scripted, modules });
    await firstTurn({
      harness: (ctx) => ({
        agent: {
          instructions: async () => builtins(ctx).prompt.instructions(await declared(ctx)),
          model: async () => (await declared(ctx)).model,
          tools: async () => ({ ...(await declared(ctx)).tools, ...builtins(ctx).tools }),
        },
      }),
      message: "What can you do?",
      model: scripted,
      modules,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.system).toContain("Write in house style.");
    expect(JSON.stringify(calls[0]!.messages)).toContain("eve__search");
    expect(calls[1]).toEqual(calls[0]);
  });

  it("offers none of eve's tools it doesn't return, and evaluates nothing it doesn't ask for", async () => {
    const offered: string[][] = [];
    const scripted = model("gpt-5.5", (options) => {
      offered.push((options.tools ?? []).map((entry) => entry.name));
      return textStreamResult("Done.");
    });
    let evaluated = 0;
    await firstTurn({
      harness: () => ({
        agent: {
          instructions: "Answer billing questions.",
          model: { model: scripted, modelContextWindowTokens: 200_000 },
          tools: { plan_lookup: tool("Look up a plan.") },
        },
      }),
      message: "What can you do?",
      model: scripted,
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              deferred: true,
              description: "Export Alice's rows.",
              execute: async () => ({}),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/export_rows.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamicInstructions(() => {
              evaluated += 1;
              return defineInstructions({ content: "Write in house style." });
            }),
          }),
          logicalPath: "instructions/house-style.ts",
        },
      ],
    });

    // A deferred tool would bring eve__search and eve__tool; the harness didn't offer them.
    expect(offered).toEqual([["plan_lookup"]]);
    expect(evaluated).toBe(0);
  });

  it("offers its own tool in place of a declared dynamic tool of the same name", async () => {
    const descriptions: Record<string, string | undefined> = {};
    const scripted = model("gpt-5.5", (options) => {
      for (const entry of options.tools ?? []) {
        descriptions[entry.name] = "description" in entry ? entry.description : undefined;
      }
      return textStreamResult("Done.");
    });
    await firstTurn({
      harness: (ctx) => ({
        agent: {
          tools: async () => ({
            ...(await declared(ctx)).tools,
            lookup: tool("Look it up the harness's way."),
          }),
        },
      }),
      message: "Look up Alice's plan.",
      model: scripted,
      modules: [
        {
          loadNamespace: async () => ({
            default: defineDynamicTools(() => ({ lookup: tool("Look it up the agent's way.") })),
          }),
          logicalPath: "tools/lookup.ts",
        },
      ],
    });

    expect(descriptions.lookup).toContain("the harness's way");
  });

  it("offers a declared tool with the description it gives, and refuses one that sets an approval", async () => {
    const descriptions: unknown[] = [];
    const scripted = model("gpt-5.5", (options) => {
      descriptions.push(
        (options.tools ?? []).flatMap((entry) =>
          entry.name === "search" && "description" in entry ? [entry.description] : [],
        ),
      );
      return textStreamResult("Done.");
    });
    const modules = [
      {
        loadNamespace: async () => ({ default: tool("Search the docs.") }),
        logicalPath: "tools/search.ts",
      },
    ];
    await firstTurn({
      harness: (ctx) => ({
        agent: {
          tools: async () => {
            const { search } = (await declared(ctx)).tools;
            return { search: { ...search!, description: "Search Alice's docs only." } };
          },
        },
      }),
      message: "What can you do?",
      model: scripted,
      modules,
    });
    const refused = await firstTurn({
      harness: (ctx) => ({
        agent: {
          tools: async () => {
            const { search } = (await declared(ctx)).tools;
            return { search: { ...search!, approval: undefined } as never };
          },
        },
      }),
      message: "What can you do?",
      model: scripted,
      modules,
    });

    expect(descriptions).toEqual([["Search Alice's docs only."]]);
    expect(JSON.stringify(refused.events)).toContain("keeps its own approval");
  });

  it("shortens a large tool result in history before the model reads it", async () => {
    const big = "row ".repeat(12_500);
    const prompts: string[] = [];
    const { events, reply } = await firstTurn({
      harness: (ctx) => ({
        agent: {
          tools: async () => ({
            ...(await declared(ctx)).tools,
            ...builtins(ctx).tools,
            export_rows: defineTool({
              description: "Export Alice's rows.",
              execute: async () => ({ rows: big }),
              inputSchema: {},
            }),
          }),
        },
        history: () =>
          ctx.history.map((message) =>
            message.role !== "tool"
              ? message
              : {
                  ...message,
                  content: message.content.map((part) =>
                    part.type === "tool-result" && JSON.stringify(part.output).length > 1_000
                      ? {
                          ...part,
                          output: { type: "text" as const, value: "(12,500 rows exported)" },
                        }
                      : part,
                  ),
                },
          ),
      }),
      message: "Export Alice's rows.",
      model: model("gpt-5.5", (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return options.prompt.at(-1)?.role === "tool"
          ? textStreamResult("Exported.")
          : toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "export_rows" });
      }),
    });

    expect(reply).toBe("Exported.");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("(12,500 rows exported)");
    expect(prompts[1]).not.toContain("row row row");
    // The model hadn't read the result, so shortening it rewrote nothing.
    expect(filterEventsByType(events, "context.started")).toEqual([]);
    const [settled] = filterEventsByType(events, "call.settled");
    expect(JSON.stringify(settled!.data)).toContain("row row row");
  });

  it("runs the model it chooses in place of the agent's", async () => {
    const reply = await firstReply({
      harness: () => ({
        agent: {
          model: {
            model: model("gpt-5.5-mini", () => textStreamResult("The small model.")),
            modelContextWindowTokens: 200_000,
          },
        },
      }),
      message: "Which model answers Bob?",
      model: model("gpt-5.5", () => textStreamResult("The agent's model.")),
    });

    expect(reply).toBe("The small model.");
  });

  it("fails the build when the file exports something other than defineHarness()", async () => {
    await expect(
      firstReply({
        harness: { invalid: true },
        message: "Hello.",
        model: model("gpt-5.5", () => textStreamResult("Hello.")),
      }),
    ).rejects.toThrow('Export defineHarness((ctx) => ({ ... })) from "harness.ts"');
  });
});
