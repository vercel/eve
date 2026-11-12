import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineMemory, type MemoryProvider } from "#public/memory/index.js";
import { defineTool } from "#tools/definition.js";

// A memory that recalls after a compaction inside a turn: the turn's next model call reads what
// it brought, joined to the turn's recall.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const SUMMARY = "Alice asked for the quarterly report.";
const REPORT = `Quarterly report. ${"Revenue grew in every region. ".repeat(10_000)}`;

function isSummaryRequest(prompt: LanguageModelV4Prompt): boolean {
  return JSON.stringify(prompt).includes("CONTEXT CHECKPOINT COMPACTION");
}

/** Each turn calls `fetch_report` once and then replies; a compaction gets a summary. */
function scriptedModel(log: string[], prompts: LanguageModelV4Prompt[]) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        if (isSummaryRequest(prompt)) {
          log.push("call:summary");
          return textStreamResult(SUMMARY);
        }
        log.push("call:turn");
        prompts.push(prompt);
        return prompt.at(-1)?.role === "tool"
          ? textStreamResult("The report is in.")
          : toolCallStreamResult({
              input: "{}",
              toolCallId: `call-${log.length}`,
              toolName: "fetch_report",
            });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
}

/** Waits until `count` turns have settled. */
async function untilSettled(log: readonly string[], count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (log.filter((value) => value.startsWith("turn:")).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} settled turns. Log: ${log.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A session whose first turn's report pushes its next call over a small window. */
async function runSession(
  name: string,
  provider: MemoryProvider,
  log: string[],
  prompts: LanguageModelV4Prompt[],
  secondTurn: boolean,
): Promise<void> {
  let fetched = 0;
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        compaction: { threshold: 1 },
        model: scriptedModel(log, prompts),
        modelContextWindowTokens: 50_000,
      } as never),
      name,
    },
    modules: [
      {
        loadNamespace: async () => ({ default: defineMemory({ provider, scope: "test" }) }),
        logicalPath: "memory/archive.ts",
      },
      {
        loadNamespace: async () => ({
          default: defineTool({
            description: "Fetch the quarterly report.",
            execute: async () => (fetched++ === 0 ? REPORT : "No changes since."),
            inputSchema: {},
          }),
        }),
        logicalPath: "tools/fetch_report.ts",
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
  const continuationToken = `http:${name}`;
  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Fetch the quarterly report." },
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken,
        }),
      },
    ]);
    try {
      await untilSettled(log, 1);
      if (secondTurn) {
        await resumeHook(sessionInboxHookToken(continuationToken), {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Fetch it again." },
        });
        await untilSettled(log, 2);
      }
    } finally {
      await run.cancel().catch(() => {});
    }
  });
}

const userTexts = (prompt: LanguageModelV4Prompt) =>
  prompt.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

describe("memory recall after a compaction", () => {
  it("joins the recall to the turn's, once, before the turn's next model call", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    await runSession(
      "compaction-recall",
      {
        recall: {
          "compaction.completed": ({ compaction, messages, operationId, turn }) => {
            log.push("recall:compaction");
            log.push(`recall:compaction:model:${compaction.modelId}`);
            log.push(`recall:compaction:turn:${turn.id.length > 0}`);
            log.push(`recall:compaction:summary:${JSON.stringify(messages).includes(SUMMARY)}`);
            log.push(`recall:compaction:operation:${operationId}`);
            return {
              messages: [
                { content: "The report Alice fetched is archived; search the archive for it." },
                { content: "Index: one line.", id: "index" },
              ],
            };
          },
          "turn.started": () => {
            log.push("recall:turn");
            return {
              messages: [
                { content: "Alice prefers short answers.", id: "preference" },
                { content: "Index: a large block.", id: "index" },
              ],
            };
          },
        },
      },
      log,
      prompts,
      true,
    );

    // One compaction inside the first turn, then one recall after it, before the next call.
    expect(log.filter((entry) => entry === "call:summary")).toHaveLength(1);
    expect(log.filter((entry) => entry === "recall:compaction")).toHaveLength(1);
    const recalledAt = log.indexOf("recall:compaction");
    expect(log.indexOf("context:compaction:completed")).toBeLessThan(recalledAt);
    expect(log.indexOf("call:summary")).toBeLessThan(recalledAt);
    expect(log.indexOf("call:turn", recalledAt)).toBeGreaterThan(recalledAt);
    expect(log).toContain("recall:compaction:model:eve-test/scripted-model");
    expect(log).toContain("recall:compaction:turn:true");
    expect(log).toContain("recall:compaction:summary:true");
    expect(log.find((entry) => entry.startsWith("recall:compaction:operation:"))).toMatch(
      /:compaction\.completed:archive:\d+$/,
    );
    // Each turn recalls once at its start; the second turn didn't compact.
    expect(log.filter((entry) => entry === "recall:turn")).toHaveLength(2);

    // The call after the compaction reads the turn's recall with the new message added and the
    // `index` message replaced, each once.
    const afterCompaction = userTexts(prompts[1]!);
    expect(afterCompaction).toContain("Alice prefers short answers.");
    expect(afterCompaction).toContain("Index: one line.");
    expect(afterCompaction).not.toContain("Index: a large block.");
    expect(
      afterCompaction.filter((text) => text.startsWith("The report Alice fetched is archived")),
    ).toHaveLength(1);
  }, 120_000);

  it("fails the turn before its next model call when the recall throws", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    await runSession(
      "compaction-recall-fails",
      {
        recall: {
          "compaction.completed": () => {
            log.push("recall:compaction");
            throw new Error("The archive is down.");
          },
          "turn.started": () => null,
        },
      },
      log,
      prompts,
      false,
    );

    expect(log).toContain("context:compaction:completed");
    expect(log.filter((entry) => entry === "recall:compaction")).toHaveLength(1);
    expect(log).toContain("turn:failed");
    // Only the call that fetched the report ran: the one after the compaction never did.
    expect(log.filter((entry) => entry === "call:turn")).toHaveLength(1);
  }, 120_000);
});
