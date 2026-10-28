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
import { defineHook, type HookDefinition } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { always } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";

// A hook's ctx.send(), read from what the model receives and what the session admits.

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

const lookup = defineTool({
  description: "Look up the report.",
  execute: () => ({ found: true }),
  inputSchema: {},
});

const publish = defineTool({
  approval: always(),
  description: "Publish the report once it's approved.",
  execute: () => ({ published: true }),
  inputSchema: {},
});

/** The model calls `lookup` on its first call and replies "Done." to every later call. */
function lookupFirst(index: number): ReturnType<typeof textStreamResult> {
  return index === 0
    ? toolCallStreamResult({ input: "{}", toolCallId: "call-lookup", toolName: "lookup" })
    : textStreamResult("Done.");
}

/**
 * Runs a session with the given hooks, whose model replies "Done." to every call unless
 * `respond` says otherwise.
 */
async function runSession(input: {
  readonly name: string;
  readonly hooks: Readonly<Record<string, HookDefinition>>;
  readonly respond?: (index: number) => ReturnType<typeof textStreamResult>;
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
        return input.respond?.(inputs.length - 1) ?? textStreamResult("Done.");
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
      "interaction.opened": () => {
        log.push("interaction:opened");
      },
      "interaction.settled": (event) => {
        log.push(`interaction:${event.data.outcome}`);
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
    modules: [
      ...Object.entries({ observe, ...input.hooks }).map(([name, hook]) => ({
        loadNamespace: async () => ({ default: hook }),
        logicalPath: `hooks/${name}.ts`,
      })),
      ...Object.entries({ lookup, publish }).map(([name, tool]) => ({
        loadNamespace: async () => ({ default: tool }),
        logicalPath: `tools/${name}.ts`,
      })),
    ],
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

describe("hook ctx.send()", () => {
  it("follows a completed turn with the next one by default, as a delivery from the hook", async () => {
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
                ctx.send(`Keep going (${settled}).`, {
                  context: ["The report needs a summary."],
                  // The second follow-up acts for Bob; the first names no sender.
                  ...(settled === 2 && { auth: BOB }),
                }),
                // A second message from the same handler adds nothing, and says so.
                ctx.send("Ignored."),
              );
            },
          },
        }),
      },
      name: "hook-send-continues",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Keep going (1).", "Keep going (2)."]);
    const sent = { deliveryId: expect.stringMatching(/^hook-/u), queued: true };
    expect(results).toEqual([
      sent,
      { queued: false, reason: "already-queued" },
      sent,
      { queued: false, reason: "already-queued" },
    ]);
    // The source keeps the channel; a follow-up names no sender unless it passes `auth`.
    expect(log.filter((entry) => /^(admitted|principal):/u.test(entry))).toEqual([
      'admitted:{"channel":"http"}',
      "principal:alice",
      'admitted:{"channel":"http","hook":"until-done"}',
      "principal:none",
      'admitted:{"channel":"http","hook":"until-done"}',
      "principal:bob",
    ]);
    // The model reads which messages the hook sent, ahead of each one, on every later call.
    const note = 'from the \\"until-done\\" hook';
    expect(prompts[1]).toContain(note);
    expect(prompts[1]).toContain("The report needs a summary.");
    expect(prompts[2]?.split(note)).toHaveLength(3);
  }, 90_000);

  it("waits on the running turn when a hook sends mid-turn with the default policy", async () => {
    const { inputs } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 2);
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Now review what you found.");
            },
          },
        }),
      },
      name: "hook-send-yield-mid-turn",
      respond: lookupFirst,
    });

    expect(inputs).toEqual([
      "Alice asks for the report.",
      "Alice asks for the report.",
      "Now review what you found.",
    ]);
  }, 90_000);

  it("steers the running turn at its next step with turnPolicy steer", async () => {
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Also include the appendix.", { turnPolicy: "steer" });
            },
          },
        }),
      },
      name: "hook-send-steer",
      respond: lookupFirst,
    });

    // One turn: the model's call after the tool result reads the hook's message.
    expect(inputs).toEqual(["Alice asks for the report.", "Also include the appendix."]);
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual(["turn:completed"]);
    expect(log).toContain('admitted:{"channel":"http","hook":"reviewer"}');
  }, 90_000);

  it("queues behind the running turn with turnPolicy queue, then starts its own", async () => {
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 2);
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Then summarize it.", { turnPolicy: "queue" });
            },
          },
        }),
      },
      name: "hook-send-queue",
      respond: lookupFirst,
    });

    expect(inputs).toEqual([
      "Alice asks for the report.",
      "Alice asks for the report.",
      "Then summarize it.",
    ]);
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:completed",
      "turn:completed",
    ]);
  }, 90_000);

  it("never steers a turn that waits on its person's approval", async () => {
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "interaction:opened", 1);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
      hooks: {
        notifier: defineHook({
          events: {
            "interaction.opened": (_event, ctx) => {
              ctx.send("Alice was asked to approve publishing.", { turnPolicy: "steer" });
            },
          },
        }),
      },
      name: "hook-send-held",
      respond: (index) =>
        index === 0
          ? toolCallStreamResult({ input: "{}", toolCallId: "call-publish", toolName: "publish" })
          : textStreamResult("Done."),
    });

    // The approval stays open for Alice, and the model isn't called again until she answers.
    expect(inputs).toEqual(["Alice asks for the report."]);
    expect(log.filter((entry) => entry.startsWith("interaction:"))).toEqual(["interaction:opened"]);
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
              if (settled === 1) ctx.send("Keep going.");
            },
          },
        }),
      },
      name: "hook-send-yields",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Bob asks for the appendix."]);
  }, 90_000);

  it("drops a follow-up when the history is cleared before it's admitted", async () => {
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
              expect(ctx.send("Keep going.")).toMatchObject({ queued: true });
            },
          },
        }),
      },
      name: "hook-send-cleared",
    });

    expect(inputs).toEqual(["Alice asks for the report."]);
    expect(log.filter((entry) => entry === "turn:completed")).toHaveLength(1);
  }, 90_000);

  it("merges follow-ups from several hooks into one next turn, for one principal", async () => {
    const settled: Record<string, number> = { audit: 0, goal: 0, lint: 0 };
    const results: Record<string, unknown[]> = { audit: [], goal: [], lint: [] };
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
                results.goal!.push(ctx.send("Keep working on the report."));
              }
            },
          },
        }),
        lint: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.lint! += 1) === 1) results.lint!.push(ctx.send("Fix the lint errors."));
            },
          },
        }),
        // A follow-up for Bob can't share a turn that acts as the session.
        "zz-audit": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.audit! += 1) === 1) {
                results.audit!.push(ctx.send("Audit it.", { auth: BOB }));
              }
            },
          },
        }),
      },
      name: "hook-send-merges",
    });

    expect(results).toEqual({
      audit: [{ queued: false, reason: "auth-conflict" }],
      goal: [expect.objectContaining({ queued: true })],
      lint: [expect.objectContaining({ queued: true })],
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("Keep working on the report.");
    expect(inputs[1]).toContain("Fix the lint errors.");
    expect(inputs[1]).not.toContain("Audit it.");
    expect(log.filter((entry) => entry.startsWith("admitted:"))).toEqual([
      'admitted:{"channel":"http"}',
      'admitted:{"channel":"http","hook":"goal"}',
      'admitted:{"channel":"http","hook":"lint"}',
    ]);
    expect(prompts[1]).toContain('from the \\"goal\\" and \\"lint\\" hooks');
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
              results.guard!.push(ctx.send("Fix the code without editing test files."));
            },
          },
        }),
        other: defineHook({
          events: {
            "turn.settled": (event, ctx) => {
              if (event.data.outcome !== "cancelled") return;
              results.other!.push(ctx.send("Keep going."));
            },
          },
        }),
      },
      name: "hook-send-redirects",
    });

    expect(results).toEqual({
      guard: [expect.objectContaining({ queued: true })],
      other: [{ queued: false, reason: "not-completed" }],
    });
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:cancelled",
      "turn:completed",
    ]);
    expect(inputs).toEqual(["Fix the code without editing test files."]);
  }, 90_000);
});
