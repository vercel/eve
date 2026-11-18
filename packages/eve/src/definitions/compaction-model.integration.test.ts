import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { defineDynamic } from "#dynamic/definition.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { resumeRoutedHook } from "#execution/hosts.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { startTestSession } from "#internal/testing/test-session-hosts.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { defineHook } from "#public/definitions/hook.js";

function isSummaryRequest(prompt: LanguageModelV4Prompt): boolean {
  return JSON.stringify(prompt).includes("CONTEXT CHECKPOINT COMPACTION");
}

function scriptedModel(log: string[], modelId: string) {
  return markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const kind = isSummaryRequest(prompt) ? "summary" : "turn";
        log.push(`${modelId}:${kind}`);
        return textStreamResult(kind === "summary" ? "Alice said hello." : "Hello.");
      },
      modelId,
      provider: "eve-test",
    }),
  );
}

async function until(log: readonly string[], entry: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!log.includes(entry)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${entry}": ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function compactOnce(pinned: boolean): Promise<string[]> {
  const log: string[] = [];
  const turnModel = scriptedModel(log, "turn");
  const pinnedModel = scriptedModel(log, "pinned");
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        compaction: {
          model: defineDynamic((ctx) => {
            log.push(`choose:${ctx.model.id}:${ctx.session.auth.current?.principalId}`);
            return pinned ? { model: pinnedModel, modelContextWindowTokens: 200_000 } : null;
          }),
        },
        model: defineDynamicModel(() => ({ model: turnModel, modelContextWindowTokens: 200_000 })),
      }),
      name: "compaction-model",
    },
    modules: [
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: {
              "context.settled": (fact) => {
                log.push(`context:${fact.data.outcome}`);
              },
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
  const continuationToken = "http:compaction-model";
  await runtime.run(async () => {
    const run = await startTestSession("in-process", {
      input: { message: "Hello." },
      kind: "initial",
      ownerDeploymentId: "dpl_inline",
      serializedContext: buildSerializedContext({
        auth: {
          attributes: {},
          authenticator: "test",
          issuer: "test",
          principalId: "alice",
          principalType: "user",
        },
        channelKind: "http",
        continuationToken,
      }),
    });
    try {
      await until(log, "turn:settled");
      await resumeRoutedHook(sessionInboxHookToken(continuationToken), {
        deliveryId: "compact",
        kind: "compact",
      });
      await until(log, "context:completed");
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return log;
}

describe("a dynamic compaction model", () => {
  it("summarizes with the model it returns, chosen from the session and the turn model", async () => {
    const log = await compactOnce(true);

    expect(log).toContain("choose:eve-test/turn:alice");
    expect(log).toContain("pinned:summary");
    expect(log).not.toContain("turn:summary");
  }, 90_000);

  it("summarizes with the turn model when it returns null", async () => {
    const log = await compactOnce(false);

    expect(log).toContain("turn:turn");
    expect(log).toContain("turn:summary");
    expect(log).not.toContain("pinned:summary");
  }, 90_000);
});
