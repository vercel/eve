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

/** The running session's log, for tools defined in a test. */
const logRef: { log?: string[] } = {};

/**
 * Runs a session with the given hooks, whose model replies "Done." to every call unless
 * `respond` says otherwise.
 */
async function runSession(input: {
  readonly name: string;
  readonly hooks: Readonly<Record<string, HookDefinition>>;
  readonly respond?: (index: number) => ReturnType<typeof textStreamResult>;
  /** Tools beside `lookup` and `publish`, or in their place. */
  readonly tools?: Readonly<Record<string, unknown>>;
  /** Holds a model call, the first by default, until `held` resolves. */
  readonly held?: Promise<void>;
  readonly heldCall?: number;
  readonly drive: (session: {
    readonly inbox: string;
    readonly log: string[];
    readonly inputs: string[];
  }) => Promise<void>;
}): Promise<{ readonly log: string[]; readonly inputs: string[]; readonly prompts: string[] }> {
  const log: string[] = [];
  logRef.log = log;
  const inputs: string[] = [];
  const prompts: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        inputs.push(lastUserText(prompt));
        prompts.push(JSON.stringify(prompt));
        if (inputs.length - 1 === (input.heldCall ?? 0)) await input.held;
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
      ...Object.entries({ lookup, publish, ...input.tools }).map(([name, tool]) => ({
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
      await input.drive({ inbox: sessionInboxHookToken(continuationToken), inputs, log });
    } finally {
      await run.cancel().catch(() => {});
    }
  });
  return { inputs, log, prompts };
}

/** A promise the test resolves to let a held model call go on. */
function gate(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

async function untilInputs(inputs: readonly string[], count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (inputs.length < count) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} model calls.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe("hook ctx.send()", () => {
  it("steers the running turn at its next step, acting for the principal it names", async () => {
    const results: unknown[] = [];
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await settle();
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              results.push(
                ctx.send("Also include the appendix.", { auth: ctx.session.auth.current }),
              );
            },
          },
        }),
      },
      name: "hook-send-steer",
      respond: lookupFirst,
    });

    // One turn: the model's call after the tool result reads the hook's message.
    expect(results).toEqual([{ deliveryId: expect.stringMatching(/^hook-/u), recorded: true }]);
    expect(inputs).toEqual(["Alice asks for the report.", "Also include the appendix."]);
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual(["turn:completed"]);
    // The source names the hook; the principal is who the message acts for.
    expect(log.filter((entry) => /^(admitted|principal):/u.test(entry))).toEqual([
      'admitted:{"channel":"http"}',
      "principal:alice",
      'admitted:{"channel":"http","hook":"reviewer"}',
      "principal:alice",
    ]);
  }, 90_000);

  it("keeps a hook's steering apart from a person's, so the model can tell them apart", async () => {
    const { held: lookupHeld, release } = gate();
    let lookups = 0;
    const { inputs, log, prompts } = await runSession({
      drive: async ({ inbox, log }) => {
        await until(log, "lookup:started", 1);
        // Alice steers while the tool runs; the hook steers once its call settles.
        await resumeHook(inbox, {
          auth: ALICE,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Alice also wants charts." },
          turnPolicy: "steer",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:completed", 2);
        await settle();
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Also include the appendix.", { auth: ctx.session.auth.current });
            },
          },
        }),
      },
      name: "hook-send-steer-apart",
      respond: lookupFirst,
      tools: {
        lookup: defineTool({
          description: "Look up the report.",
          execute: async () => {
            lookups += 1;
            logRef.log?.push("lookup:started");
            await lookupHeld;
            return { found: true, lookups };
          },
          inputSchema: {},
        }),
      },
    });

    // Alice's message steers the turn's next call; the hook's waits for the next step, which this
    // turn doesn't take, so it starts its own turn, with the note ahead of it.
    expect(inputs).toEqual([
      "Alice asks for the report.",
      "Alice also wants charts.",
      "Also include the appendix.",
    ]);
    expect(prompts[1]).not.toContain("sent automatically");
    expect(prompts[1]).not.toContain("Also include the appendix.");
    expect(prompts[2]).toContain("sent automatically, not by a person");
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:completed",
      "turn:completed",
    ]);
  }, 90_000);

  it("queues behind the running turn with turnPolicy queue, then starts its own", async () => {
    const { inputs, log, prompts } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 2);
        await settle();
      },
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Then summarize it.", {
                auth: ctx.session.auth.current,
                context: ["The summary goes first."],
                turnPolicy: "queue",
              });
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
    // The model reads that the hook sent it, and the context it passed.
    expect(prompts[2]).toContain("sent automatically, not by a person");
    expect(prompts[2]).toContain("The summary goes first.");
  }, 90_000);

  it("follows a completed turn with a yielding message until the hook stops", async () => {
    let settled = 0;
    const { inputs } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 3);
        await settle();
      },
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              settled += 1;
              if (settled > 2) return;
              ctx.send(`Keep going (${settled}).`, {
                auth: ctx.session.auth.current,
                turnPolicy: "yield",
              });
            },
          },
        }),
      },
      name: "hook-send-yield-continues",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Keep going (1).", "Keep going (2)."]);
  }, 90_000);

  it("drops a yielding message for a message that was waiting when the turn settled", async () => {
    const { held, release } = gate();
    let settled = 0;
    const { inputs } = await runSession({
      drive: async ({ inbox, log }) => {
        await until(log, 'admitted:{"channel":"http"}', 1);
        // Bob asks while the first turn still runs; his message waits behind it.
        await resumeHook(inbox, {
          auth: BOB,
          delivery: createChannelDeliveryMetadata({ channelKind: "http", channelName: "test" }),
          kind: "send",
          payload: { message: "Bob asks for the appendix." },
          turnPolicy: "queue",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:completed", 2);
        await settle();
      },
      held,
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              settled += 1;
              if (settled === 1) {
                ctx.send("Keep going.", {
                  auth: ctx.session.auth.current,
                  turnPolicy: "yield",
                });
              }
            },
          },
        }),
      },
      name: "hook-send-yield-preempted",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Bob asks for the appendix."]);
  }, 90_000);

  it("shares one turn among yielding messages for one principal, and drops the rest", async () => {
    const settled: Record<string, number> = { audit: 0, goal: 0, lint: 0 };
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 2);
        await settle();
      },
      hooks: {
        goal: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.goal! += 1) === 1) {
                ctx.send("Keep working on the report.", {
                  auth: ctx.session.auth.current,
                  turnPolicy: "yield",
                });
              }
            },
          },
        }),
        lint: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.lint! += 1) === 1) {
                ctx.send("Fix the lint errors.", {
                  auth: ctx.session.auth.current,
                  turnPolicy: "yield",
                });
              }
            },
          },
        }),
        // Bob's message can't share Alice's turn, which starts first and preempts it.
        "zz-audit": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              if ((settled.audit! += 1) === 1) {
                ctx.send("Audit it.", { auth: BOB, turnPolicy: "yield" });
              }
            },
          },
        }),
      },
      name: "hook-send-yield-shares",
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
              ctx.send("Alice was asked to approve publishing.", {
                auth: ctx.session.auth.current,
              });
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

  it("lets a person's cancel stop a hook that queues a turn after every turn", async () => {
    const { held, release } = gate();
    const results: unknown[] = [];
    const { inputs, log } = await runSession({
      drive: async ({ inbox, inputs, log }) => {
        // The hook's second turn is running when Alice cancels.
        await untilInputs(inputs, 2);
        await resumeHook(inbox, { deliveryId: "cancel-1", kind: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:cancelled", 1);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
      held,
      heldCall: 1,
      hooks: {
        again: defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              results.push(
                ctx.send("Run the checks again.", {
                  auth: ctx.session.auth.current,
                  turnPolicy: "queue",
                }),
              );
            },
          },
        }),
      },
      name: "hook-send-cancel-stops-loop",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Run the checks again."]);
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:completed",
      "turn:cancelled",
    ]);
    expect(results.at(-1)).toEqual({ reason: "cancelled", recorded: false });
  }, 90_000);

  it("drops a hook's queued message when a person cancels the turn it waits behind", async () => {
    const { held, release } = gate();
    const { inputs, log } = await runSession({
      drive: async ({ inbox, inputs, log }) => {
        // The hook queued its message after the tool call; the turn's next call is running.
        await untilInputs(inputs, 2);
        await resumeHook(inbox, { deliveryId: "cancel-1", kind: "cancel" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:cancelled", 1);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      },
      held,
      heldCall: 1,
      hooks: {
        reviewer: defineHook({
          events: {
            "call.settled": (_event, ctx) => {
              ctx.send("Then summarize it.", {
                auth: ctx.session.auth.current,
                turnPolicy: "queue",
              });
            },
          },
        }),
      },
      name: "hook-send-cancel-drops-queued",
      respond: lookupFirst,
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Alice asks for the report."]);
    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual(["turn:cancelled"]);
  }, 90_000);

  it("drops a hook's message when the history is cleared before it's admitted", async () => {
    const { held, release } = gate();
    const { inputs, log } = await runSession({
      drive: async ({ inbox, log }) => {
        await until(log, 'admitted:{"channel":"http"}', 1);
        // Alice clears the conversation while the first turn still runs; the clear waits for it.
        await resumeHook(inbox, { deliveryId: "clear-1", kind: "clear" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await until(log, "turn:completed", 1);
        await until(log, 'admitted:{"control":"clear"}', 1);
        await settle();
      },
      held,
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (_event, ctx) => {
              ctx.send("Keep going.", { auth: ctx.session.auth.current, turnPolicy: "queue" });
            },
          },
        }),
      },
      name: "hook-send-cleared",
    });

    expect(inputs).toEqual(["Alice asks for the report."]);
    expect(log.filter((entry) => entry === "turn:completed")).toHaveLength(1);
  }, 90_000);

  it("lets a hook cancel a turn and send a correction", async () => {
    let started = 0;
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await settle();
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
              ctx.send("Fix the code without editing test files.", {
                auth: ctx.session.auth.current,
                turnPolicy: "yield",
              });
            },
          },
        }),
      },
      name: "hook-send-redirects",
    });

    expect(log.filter((entry) => entry.startsWith("turn:"))).toEqual([
      "turn:cancelled",
      "turn:completed",
    ]);
    expect(inputs).toEqual(["Fix the code without editing test files."]);
  }, 90_000);
});
