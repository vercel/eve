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
import { defineMemory } from "#public/memory/index.js";
import { defineTool } from "#tools/definition.js";
import { defineDurableCallback } from "#tools/durable-callbacks.js";

// Pins when today's participants run, by what they record and what the model receives rather
// than by stream events, so the pins hold while the stream format changes underneath them.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const RECALLED = "Recalled: Alice prefers short answers.";

function isSummaryRequest(prompt: LanguageModelV4Prompt): boolean {
  return JSON.stringify(prompt).includes("CONTEXT CHECKPOINT COMPACTION");
}

/** Each turn calls `lookup` once and then replies; a compaction gets a summary. */
function scriptedModel(log: string[], prompts: LanguageModelV4Prompt[]) {
  return markMockModel(
    new MockLanguageModelV4({
      // Compaction asks for its summary without streaming.
      doGenerate: async ({ prompt }) => {
        log.push(isSummaryRequest(prompt) ? "call:summary" : "call:unexpected");
        return {
          content: [{ text: "Alice asked for two lookups.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage: {
            inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
            outputTokens: { reasoning: 0, text: 1, total: 1 },
          },
          warnings: [],
        };
      },
      doStream: async ({ prompt }) => {
        if (isSummaryRequest(prompt)) {
          log.push("call:summary");
          return textStreamResult("Alice asked for two lookups.");
        }
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

/** A resolver module for `kind` that logs each key it runs on and returns `result`. */
function loggingResolver(
  log: string[],
  kind: string,
  logicalPath: string,
  keys: readonly ("session.started" | "turn.started" | "step.started")[],
  result: (key: string) => unknown = () => null,
) {
  const events = Object.fromEntries(
    keys.map((key) => [
      key,
      () => {
        log.push(`${kind}:${key.split(".")[0]}`);
        return result(key);
      },
    ]),
  );
  return { loadNamespace: async () => ({ default: defineDynamic({ events }) }), logicalPath };
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

/** The entries one turn logged: everything after the previous turn's capture. */
function turnSlice(log: readonly string[], turn: number): string[] {
  const ends = log.flatMap((entry, index) => (entry === "capture:turn" ? [index] : []));
  return log.slice(turn === 0 ? 0 : ends[turn - 1]! + 1, ends[turn]! + 1);
}

describe("participant timing", () => {
  it("runs memory, the dynamic model, and each resolver at its moment", async () => {
    const log: string[] = [];
    const prompts: LanguageModelV4Prompt[] = [];
    const model = scriptedModel(log, prompts);
    const runtime = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic({
            events: {
              "step.started": () => {
                log.push("model:step");
                return { model, modelContextWindowTokens: 200_000 };
              },
            },
          }),
        }),
        name: "participant-timing",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineMemory({
              provider: {
                recall: {
                  "turn.started": () => {
                    log.push("recall:turn");
                    return { messages: [{ content: RECALLED }] };
                  },
                  "compaction.completed": () => {
                    log.push("recall:compaction");
                    return null;
                  },
                },
                capture: {
                  "compaction.requested": () => {
                    log.push("capture:compaction");
                  },
                  "turn.completed": () => {
                    log.push("capture:turn");
                  },
                },
              },
              scope: "test",
            }),
          }),
          logicalPath: "memory/notes.ts",
        },
        loggingResolver(
          log,
          "tools",
          "tools/lookup.ts",
          ["session.started", "turn.started", "step.started"],
          (key) =>
            key === "step.started"
              ? {
                  lookup: defineTool({
                    description: "Look something up.",
                    // In-memory modules skip the source transform that makes inline
                    // callbacks durable.
                    execute: defineDurableCallback({
                      callback: async () => ({ found: true }),
                      closure: {},
                    }),
                    inputSchema: {},
                  }),
                }
              : {},
        ),
        loggingResolver(log, "skills", "skills/playbook.ts", ["session.started", "turn.started"]),
        loggingResolver(log, "instructions", "instructions/policy.ts", [
          "session.started",
          "turn.started",
        ]),
      ],
    });
    const continuationToken = "http:participant-timing";

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
        await resumeHook(inbox, { kind: "compact" });
        await until(log, "recall:compaction", 1);
      } finally {
        await run.cancel().catch(() => {});
      }
    });

    for (const turn of [0, 1]) {
      const entries = turnSlice(log, turn);
      const firstCall = entries.indexOf("call:turn");

      // Recall comes first, so the model and the turn's resolvers see what it brought back.
      expect(entries.indexOf("recall:turn")).toBeLessThan(entries.indexOf("tools:turn"));
      expect(entries.indexOf("recall:turn")).toBeLessThan(firstCall);

      // Turn-start resolvers run once per turn, before the first model call.
      for (const entry of ["tools:turn", "skills:turn", "instructions:turn"]) {
        expect(entries.filter((value) => value === entry)).toHaveLength(1);
        expect(entries.indexOf(entry)).toBeLessThan(firstCall);
      }

      // The model and the tools are resolved again before every model call.
      expect(
        entries.filter((entry) => ["model:step", "tools:step", "call:turn"].includes(entry)),
      ).toEqual(["model:step", "tools:step", "call:turn", "model:step", "tools:step", "call:turn"]);

      // Capture follows the turn's last model call.
      expect(entries.at(-1)).toBe("capture:turn");
    }

    // Session resolvers run once, at the session's start.
    for (const entry of ["tools:session", "skills:session", "instructions:session"]) {
      expect(log.filter((value) => value === entry)).toHaveLength(1);
      expect(log.indexOf(entry)).toBeLessThan(log.indexOf("call:turn"));
    }

    // Each turn's first model call carries what memory recalled for it, and its second the
    // result of the tool the step's resolver supplied.
    for (const turn of [0, 1]) {
      expect(JSON.stringify(prompts[turn * 2])).toContain(RECALLED);
      expect(JSON.stringify(prompts[turn * 2 + 1])).toContain('"found":true');
    }

    // A manual compaction captures before its summary call, resolves the model for it, and
    // recalls after; tool, skill, and instruction resolvers never see it.
    const compaction = log.slice(log.lastIndexOf("capture:turn") + 1);
    const summary = compaction.indexOf("call:summary");
    expect(compaction.filter((entry) => entry === "call:summary")).toHaveLength(1);
    expect(compaction.filter((entry) => entry === "model:step")).toHaveLength(1);
    expect(compaction.indexOf("model:step")).toBeLessThan(summary);
    expect(compaction.indexOf("capture:compaction")).toBeLessThan(summary);
    expect(compaction.indexOf("recall:compaction")).toBeGreaterThan(summary);
    expect(compaction.filter((entry) => /^(tools|skills|instructions):/u.test(entry))).toEqual([]);
  }, 90_000);
});
