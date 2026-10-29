import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelDeliveryMetadata } from "#channel/delivery-metadata.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";

// A hook's ctx.continue() from a settled turn, read from what the model receives and what the
// session admits.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const BOB = { ...ALICE, principalId: "bob" };

function lastUserText(prompt: LanguageModelV4Prompt): string {
  for (const message of [...prompt].reverse()) {
    if (message.role !== "user") continue;
    return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
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

/** Runs a session whose model replies "Done." to every turn, with the given hooks. */
async function runSession(input: {
  readonly name: string;
  readonly hooks: Readonly<Record<string, HookDefinition>>;
  /** Holds the first model call until it resolves. */
  readonly firstCall?: Promise<void>;
  readonly drive: (session: { readonly inbox: string; readonly log: string[] }) => Promise<void>;
}): Promise<{ readonly log: string[]; readonly inputs: string[]; readonly prompts: string[] }> {
  const log: string[] = [];
  const inputs: string[] = [];
  const prompts: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        inputs.push(lastUserText(prompt));
        prompts.push(JSON.stringify(prompt));
        if (inputs.length === 1) await input.firstCall;
        return textStreamResult("Done.");
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const observe = defineHook({
    events: {
      "delivery.admitted": (event) => {
        log.push(`admitted:${JSON.stringify(event.data.source ?? null)}`);
        log.push(`principal:${event.data.principal?.id ?? "none"}`);
      },
      "turn.settled": (event) => {
        log.push(`turn:${event.data.outcome}`);
      },
    },
  });
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name: input.name,
    },
    modules: Object.entries({ observe, ...input.hooks }).map(([name, hook]) => ({
      loadNamespace: async () => ({ default: hook }),
      logicalPath: `hooks/${name}.ts`,
    })),
  });
  const continuationToken = `http:${input.name}`;
  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: "Alice asks for the report." },
        serializedContext: buildSerializedContext({
          auth: ALICE,
          channelKind: "http",
          continuationToken,
        }),
      },
    ]);
    try {
      await input.drive({ inbox: sessionInboxHookToken(continuationToken), log });
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { inputs, log, prompts };
}

describe("hook ctx.continue()", () => {
  it("starts the next turn after a completed turn, as a delivery from the hook", async () => {
    let settled = 0;
    const results: unknown[] = [];
    const { inputs, log, prompts } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 3);
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              settled += 1;
              if (settled > 2) return;
              results.push(
                ctx.continue(`Keep going (${settled}).`, {
                  context: ["The report needs a summary."],
                  // The second continuation acts for Bob; the first names no sender.
                  ...(settled === 2 && { auth: BOB }),
                }),
                // A second continuation of the same turn adds nothing, and says so.
                ctx.continue("Ignored."),
              );
            },
          },
        }),
      },
      name: "hook-continue-continues",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Keep going (1).", "Keep going (2)."]);
    expect(results).toEqual([
      { queued: true },
      { queued: false, reason: "already-queued" },
      { queued: true },
      { queued: false, reason: "already-queued" },
    ]);
    // The source keeps the channel; a continuation names no sender unless it passes `auth`.
    expect(log.filter((entry) => /^(admitted|principal):/u.test(entry))).toEqual([
      'admitted:{"channel":"http"}',
      "principal:alice",
      'admitted:{"channel":"http","hook":"until-done"}',
      "principal:none",
      'admitted:{"channel":"http","hook":"until-done"}',
      "principal:bob",
    ]);
    // History notes ahead of each continuation that no person wrote it, so every later call reads it.
    const note = "sent automatically after the last turn, not by a person";
    expect(prompts[1]).toContain(note);
    expect(prompts[1]).toContain("The report needs a summary.");
    expect(prompts[2]?.split(note)).toHaveLength(3);
  }, 90_000);

  it("reports why a * handler's continuation wasn't queued, and offers none to other events", async () => {
    const results: unknown[] = [];
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      hooks: {
        every: defineHook({
          events: {
            "*": (event, ctx) => {
              if (event.type === "turn.started") results.push(ctx.continue("Too early."));
            },
            "turn.started": (_event, ctx) => {
              // @ts-expect-error Only turn.settled and * handlers can continue.
              results.push(typeof ctx.continue);
            },
          },
        }),
      },
      name: "hook-continue-ineligible",
    });

    expect(results).toEqual(["undefined", { queued: false, reason: "not-settled" }]);
    expect(inputs).toEqual(["Alice asks for the report."]);
    expect(log.filter((entry) => entry === "turn:completed")).toHaveLength(1);
  }, 90_000);

  it("yields to a message that was waiting when the turn settled", async () => {
    let release!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = 0;
    const { inputs } = await runSession({
      drive: async ({ inbox, log }) => {
        await until(log, 'admitted:{"channel":"http"}', 1);
        // Bob asks while the first turn still runs; his message waits behind it.
        await resumeHook(inbox, {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Bob asks for the appendix." },
          turnPolicy: "queue",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:completed", 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      firstCall,
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              settled += 1;
              if (settled === 1) ctx.continue("Keep going.");
            },
          },
        }),
      },
      name: "hook-continue-yields",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Bob asks for the appendix."]);
  }, 90_000);

  it("drops a continuation when the history is cleared before it's admitted", async () => {
    let release!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { inputs, log } = await runSession({
      drive: async ({ inbox, log }) => {
        await until(log, 'admitted:{"channel":"http"}', 1);
        // Alice clears the conversation while the first turn still runs; the clear waits for it.
        await resumeHook(inbox, { deliveryId: "clear-1", kind: "clear" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:completed", 1);
        await until(log, 'admitted:{"control":"clear"}', 1);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      firstCall,
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              expect(ctx.continue("Keep going.")).toEqual({ queued: true });
            },
          },
        }),
      },
      name: "hook-continue-cleared",
    });

    expect(inputs).toEqual(["Alice asks for the report."]);
    expect(log.filter((entry) => entry === "turn:completed")).toHaveLength(1);
  }, 90_000);

  it("merges continuations from several hooks into one next turn, for one principal", async () => {
    const settled: Record<string, number> = { audit: 0, goal: 0, lint: 0, review: 0 };
    const results: Record<string, unknown[]> = { audit: [], goal: [], lint: [], review: [] };
    const { inputs, log, prompts } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 2);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      hooks: {
        goal: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.goal! += 1) === 1) {
                results.goal!.push(ctx.continue("Keep working on the report."));
              }
            },
          },
        }),
        lint: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.lint! += 1) === 1)
                results.lint!.push(ctx.continue("Fix the lint errors."));
            },
          },
        }),
        // Naming Alice, the session's identity, acts for the same principal as naming no one.
        review: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.review! += 1) === 1) {
                results.review!.push(ctx.continue("Review the summary.", { auth: ALICE }));
              }
            },
          },
        }),
        // A continuation for Bob can't share a turn that acts for Alice.
        "zz-audit": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.audit! += 1) === 1) {
                results.audit!.push(ctx.continue("Audit it.", { auth: BOB }));
              }
            },
          },
        }),
      },
      name: "hook-continue-merges",
    });

    expect(results).toEqual({
      audit: [{ queued: false, reason: "auth-conflict" }],
      goal: [{ queued: true }],
      lint: [{ queued: true }],
      review: [{ queued: true }],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Keep working on the report.");
    expect(inputs[1]).toContain("Fix the lint errors.");
    expect(inputs[1]).toContain("Review the summary.");
    expect(inputs[1]).not.toContain("Audit it.");
    expect(log.filter((entry) => entry.startsWith("admitted:"))).toEqual([
      'admitted:{"channel":"http"}',
      'admitted:{"channel":"http","hook":"goal"}',
      'admitted:{"channel":"http","hook":"lint"}',
      'admitted:{"channel":"http","hook":"review"}',
    ]);
    expect(prompts[1]?.split("not by a person")).toHaveLength(2);
  }, 90_000);

  it("lets the hook that cancelled a turn redirect it, and no other hook", async () => {
    let started = 0;
    const results: Record<string, unknown[]> = { guard: [], other: [] };
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      hooks: {
        guard: defineHook({
          events: {
            "turn.started": (_event, ctx) => {
              started += 1;
              if (started === 1) ctx.cancel("The agent was about to edit test files.");
            },
            "turn.settled": (event, ctx) => {
              if (event.data.outcome !== "cancelled") return;
              results.guard!.push(ctx.continue("Fix the code without editing test files."));
            },
          },
        }),
        other: defineHook({
          events: {
            "turn.settled": (event, ctx) => {
              if (event.data.outcome !== "cancelled") return;
              results.other!.push(ctx.continue("Keep going."));
            },
          },
        }),
      },
      name: "hook-continue-redirects",
    });

    expect(results).toEqual({
      guard: [{ queued: true }],
      other: [{ queued: false, reason: "not-completed" }],
    });
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:cancelled",
      "turn:completed",
    ]);
    expect(inputs).toEqual(["Fix the code without editing test files."]);
  }, 90_000);
});
