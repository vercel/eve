import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineTool } from "#tools/definition.js";

import { defineDynamic } from "#public/definitions/model.js";

import { auto } from "./auto.js";

// auto() as an agent's model field, run through the runtime: what it decides, how often, and which
// model each call reaches, with and without a fresh process for every step.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

/** A model that calls `lookup` once per turn and then replies, logging each call by name. */
function scriptedModel(name: string, modelId: string, log: string[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }: { prompt: LanguageModelV4Prompt }) => {
        log.push(`call:${name}`);
        return prompt.at(-1)?.role === "tool"
          ? textStreamResult(`Done by ${name}.`)
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `call-${log.length}`,
              toolName: "lookup",
            });
      },
      modelId,
      provider: "openai",
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

async function runTwoTurns(): Promise<{ readonly log: string[]; readonly decisions: string[] }> {
  const log: string[] = [];
  const decisions: string[] = [];
  const decider = new Experimental_DecisionMockModelV4({
    doDecide: async ({ state }) => {
      const serialized = JSON.stringify(state);
      decisions.push(serialized);
      // The latest message decides: earlier turns are context.
      const latest = (state as { messages: { text: string }[] }).messages.at(-1)?.text ?? "";
      return {
        answers: {
          route: { choice: latest.includes("difficult") ? "large" : "small", type: "choice" },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
    modelId: "decider",
  });
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: auto({
          model: decider,
          options: {
            large: {
              description: "Difficult work",
              model: scriptedModel("large", "gpt-5.5", log),
              modelContextWindowTokens: 200_000,
            },
            small: {
              description: "Routine work",
              model: scriptedModel("small", "gpt-5.5-mini", log),
              modelContextWindowTokens: 200_000,
            },
          },
        }),
      }),
      name: "auto-routing",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Look something up.",
            execute: async () => {
              log.push("tool:lookup");
              // The first turn's lookup waits for a message that steers the turn.
              if (log.filter((entry) => entry === "tool:lookup").length === 1) {
                await until(log, "steered", 1);
              }
              return { found: true };
            },
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/lookup.ts",
      },
    ],
  });
  const continuationToken = "http:auto-routing";
  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        input: { message: "Alice needs a routine summary." },
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken,
        }),
      },
    ]);
    const inbox = sessionInboxHookToken(continuationToken);
    try {
      await until(log, "tool:lookup", 1);
      await resumeHook(inbox, {
        auth: ALICE,
        kind: "send",
        payload: { message: "Actually, make it a difficult one." },
      });
      log.push("steered");
      await until(log, "call:small", 2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await resumeHook(inbox, {
        auth: ALICE,
        kind: "send",
        payload: { message: "Bob needs a difficult investigation." },
      });
      await until(log, "call:large", 2);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { decisions, log };
}

/** The first turn's calls, steered with a second message, reached small; the second's, large. */
function expectCallsPerTurn(log: readonly string[]): void {
  const calls = log.filter((entry) => entry.startsWith("call:"));
  const firstLarge = calls.indexOf("call:large");
  expect(calls.slice(0, firstLarge)).toEqual(["call:small", "call:small", "call:small"]);
  expect(calls.slice(firstLarge)).toEqual(["call:large", "call:large"]);
}

describe("auto() as the agent's model", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decides once per turn, steered or not, and each turn's calls reach its model", async () => {
    const { decisions, log } = await runTwoTurns();

    expect(decisions).toHaveLength(2);
    // Steering the first turn toward difficult work didn't decide again: its calls stayed small.
    // The second turn decides with the first as context.
    expect(decisions[0]).not.toContain("Actually");
    expect(decisions[1]).toContain("Alice needs a routine summary.");
    expect(decisions[1]).toContain("Done by small.");
    expectCallsPerTurn(log);
  }, 60_000);

  it("rebuilds the chosen model in a fresh process without deciding again", async () => {
    // Every step forgets the code it built, as a process that didn't build it would.
    vi.stubEnv("EVE_REACTIONS_COLD", "1");
    const { decisions, log } = await runTwoTurns();

    expect(decisions).toHaveLength(2);
    expectCallsPerTurn(log);
  }, 60_000);

  it("fails the model call when a fresh process resolves a different model", async () => {
    vi.stubEnv("EVE_REACTIONS_COLD", "1");
    const log: string[] = [];
    let resolves = 0;
    const small = scriptedModel("small", "gpt-5.5-mini", log);
    const large = scriptedModel("large", "gpt-5.5", log);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          // Not a function of its selection: resolving again returns another model.
          model: defineDynamic({
            select: () => null,
            resolve: () => {
              resolves += 1;
              log.push("resolve");
              return { model: resolves === 1 ? small : large, modelContextWindowTokens: 200_000 };
            },
          }),
        }),
        name: "model-drift",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Look something up.",
              execute: async () => ({ found: true }),
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/lookup.ts",
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Alice needs a routine summary." },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildSerializedContext({
            auth: ALICE,
            channelKind: "http",
            continuationToken: "http:model-drift",
          }),
        },
      ]);
      try {
        await until(log, "resolve", 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    // The rebuilt model differed from the one the session chose, so no call reached it.
    expect(log.filter((entry) => entry.startsWith("call:"))).toEqual(["call:small"]);
  }, 60_000);
});
