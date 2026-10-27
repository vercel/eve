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

// A hook's ctx.send() from a settled turn, read from what the model receives and what the session
// admits.

const ALICE = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user" as const,
};

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
}): Promise<{ readonly log: string[]; readonly inputs: string[] }> {
  const log: string[] = [];
  const inputs: string[] = [];
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        inputs.push(lastUserText(prompt));
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
  return { inputs, log };
}

describe("hook ctx.send()", () => {
  it("starts the next turn after a completed turn, as a delivery from the hook", async () => {
    let settled = 0;
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 3);
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      hooks: {
        "until-done": defineHook({
          events: {
            "turn.settled": (event, ctx) => {
              settled += 1;
              if (settled > 2) return;
              ctx.send(`Keep going (${settled}).`, { context: ["The report needs a summary."] });
              // A second send for the same turn adds nothing.
              ctx.send("Ignored.");
              expect(event.data.outcome).toBe("completed");
            },
          },
        }),
      },
      name: "hook-send-continues",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Keep going (1).", "Keep going (2)."]);
    expect(log.filter((entry) => entry.startsWith("admitted:"))).toEqual([
      'admitted:{"channel":"http"}',
      'admitted:{"hook":"until-done"}',
      'admitted:{"hook":"until-done"}',
    ]);
    expect(log.filter((entry) => entry === "turn:completed")).toHaveLength(3);
  }, 90_000);

  it("ignores a send from an event other than a completed turn.settled", async () => {
    const { inputs, log } = await runSession({
      drive: async ({ log }) => {
        await until(log, "turn:completed", 1);
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      hooks: {
        early: defineHook({
          events: {
            "turn.started": (_event, ctx) => {
              ctx.send("Too early.");
            },
          },
        }),
      },
      name: "hook-send-ineligible",
    });

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
              if (settled === 1) ctx.send("Keep going.");
            },
          },
        }),
      },
      name: "hook-send-yields",
    });

    expect(inputs).toEqual(["Alice asks for the report.", "Bob asks for the appendix."]);
  }, 90_000);
});
