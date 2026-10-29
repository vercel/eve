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
import { defineDynamic } from "#public/definitions/model.js";
import { defineTool } from "#tools/definition.js";

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

async function firstReply(input: {
  readonly harness: Harness | { readonly invalid: true };
  readonly model: ReturnType<typeof model>;
  readonly message: string;
}): Promise<string | null> {
  const runtime = await createTestRuntime({
    agent: {
      // Tests replace a static model with eve's mock; a dynamic one keeps the scripted model.
      definition: defineAgent({
        model: defineDynamic(() => ({ model: input.model, modelContextWindowTokens: 200_000 })),
      }),
      name: "harness-probe",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: typeof input.harness === "function" ? defineHarness(input.harness) : {},
        }),
        logicalPath: "harness.ts",
      },
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
    return await readFirstTurnReply(run);
  });
}

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
    const calls: { readonly system: string; readonly tools: readonly string[] }[] = [];
    const reply = await firstReply({
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
                return { seats: 10 };
              },
              inputSchema: {},
            }),
          }),
        },
        next: () =>
          ctx.continuations === 0 && ctx.lastStep?.text?.includes("[1]") === false
            ? { model: { note: "Cite the lookup as [1]." } }
            : undefined,
      }),
      message: "How many seats does Alice have?",
      model: model("gpt-5.5", (options) => {
        calls.push({
          system: systemOf(options),
          tools: (options.tools ?? []).map((tool) => tool.name),
        });
        if (options.prompt.at(-1)?.role !== "tool" && lastText(options).includes("Cite")) {
          return textStreamResult("Alice has 10 seats [1].");
        }
        if (options.prompt.at(-1)?.role === "tool") return textStreamResult("Alice has 10 seats.");
        return toolCallStreamResult({ input: "{}", toolCallId: "call-1", toolName: "plan_lookup" });
      }),
    });

    expect(reply).toBe("Alice has 10 seats [1].");
    expect(lookups).toEqual(["plan_lookup"]);
    // Three model calls, one lookup: the memo keeps it, in a fresh process too.
    expect(fetches).toEqual(["plan"]);
    expect(calls).toHaveLength(3);
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
