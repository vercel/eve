import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workflowEntry } from "#execution/session/entry.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  textStreamResult,
  toolCallStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { start } from "#internal/workflow/runtime.js";
import { defineAgent } from "#public/definitions/agent.js";
import { findCommand, runCommand } from "#public/definitions/command.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineDynamic as defineDynamicModel } from "#public/definitions/model.js";
import { deliveries, emptySessionView, foldEvents } from "#public/events/index.js";
import { sessions } from "#public/server/index.js";
import { defineTool } from "#tools/definition.js";

import { askAside, btwCommand, type AsideInput } from "./index.js";

// A side question asked while a turn is busy in a long tool call: it is answered from the session
// as it stands, and the running turn never hears about it.

const TASK = "Run the release build for web-app.";
const QUESTION = "btw, which project is this building?";

function promptText(prompt: LanguageModelV4Prompt): string {
  return JSON.stringify(prompt);
}

async function until(done: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readTypes(sessionId: string): Promise<string[]> {
  const types: string[] = [];
  for await (const event of sessions.attach(sessionId).stream({ follow: false })) {
    types.push(event.type);
  }
  return types;
}

async function untilAsync(done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the stream.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs one turn whose model calls a `build` tool that blocks until released, then replies. While
 * the tool blocks, `aside(sessionId)` runs. Returns the aside's result, every main model prompt,
 * and how the turn settled.
 */
async function runWithAside<T>(name: string, aside: (sessionId: string) => Promise<T>) {
  const prompts: string[] = [];
  const settled: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  const build = defineTool({
    description: "Run a build.",
    inputSchema: z.object({ project: z.string() }),
    async execute({ project }) {
      started = true;
      await released;
      return { project, status: "passed" };
    },
  });
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(promptText(prompt));
        if (prompts.length > 1) return textStreamResult("The web-app build passed.");
        return toolCallStreamResult({
          input: JSON.stringify({ project: "web-app" }),
          toolCallId: "call-build",
          toolName: "build",
        });
      },
      modelId: "scripted-model",
      provider: "eve-test",
    }),
  );
  const runtime = await createTestRuntime({
    agent: {
      definition: defineAgent({
        model: defineDynamicModel(() => ({ model, modelContextWindowTokens: 200_000 })),
      }),
      name,
    },
    modules: [
      { loadNamespace: async () => ({ default: build }), logicalPath: "tools/build.ts" },
      {
        loadNamespace: async () => ({
          default: defineHook({
            events: { "turn.settled": (event) => void settled.push(event.data.outcome) },
          }),
        }),
        logicalPath: "hooks/observe.ts",
      },
    ],
  });

  let result!: T;
  let consumedTexts: string[] = [];
  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: TASK },
        serializedContext: buildSerializedContext({
          channelKind: "http",
          continuationToken: `http:${name}`,
        }),
      },
    ]);
    try {
      await until(
        () => started,
        () => `prompts ${prompts.length}`,
      );
      // The stream's writer flushes asynchronously; ask once the tool call is durable, as a person
      // watching it run would.
      await untilAsync(async () => (await readTypes(run.runId)).includes("call.started"));
      result = await aside(run.runId);
      release();
      await until(
        () => settled.length >= 1,
        () => `prompts ${prompts.length}, settled ${settled.length}`,
      );
      const events = [];
      for await (const event of sessions.attach(run.runId).stream({ follow: false })) {
        events.push(event);
      }
      consumedTexts = deliveries(foldEvents(emptySessionView(), events)).flatMap(({ parts }) =>
        (parts ?? []).flatMap((part) => (part.kind === "text" ? [part.text] : [])),
      );
    } finally {
      release();
      await run.cancel().catch(() => {});
    }
  });
  return { consumedTexts, prompts, result, settled };
}

describe("eve/extensions/btw", () => {
  it("answers from the running turn without reaching it", async () => {
    const seen: AsideInput[] = [];
    const { consumedTexts, prompts, result, settled } = await runWithAside("btw", (sessionId) =>
      askAside(sessionId, QUESTION, {
        answer: async (input) => {
          seen.push(input);
          return "It's building web-app.";
        },
      }),
    );

    expect(result).toBe("It's building web-app.");
    expect(seen).toHaveLength(1);
    const { question, transcript } = seen[0]!;
    expect(question).toBe(QUESTION);
    // The answerer sees the task and the call still in flight, inside the running turn.
    expect(transcript).toContain('<turn status="running">');
    expect(transcript).toContain(`<user>${JSON.stringify(TASK)}</user>`);
    expect(transcript).toMatch(
      /<call>\{"name":"build","state":"running","input":\{"project":"web-app"\}\}<\/call>/,
    );

    // The turn finishes on its own, one model call after the tool, and never sees the question.
    expect(settled).toEqual(["completed"]);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).not.toContain("which project");
    expect(consumedTexts).toEqual([TASK]);
  }, 90_000);

  it("runs as a command and answers with the model, shown only to the caller", async () => {
    const asked: string[] = [];
    const sideModel = new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        asked.push(promptText(prompt));
        return {
          content: [{ type: "text", text: "It's building web-app." }],
          finishReason: { raw: undefined, unified: "stop" },
          usage,
          warnings: [],
        };
      },
      modelId: "side-model",
      provider: "eve-test",
    });
    const commands = { btw: btwCommand({ model: sideModel }) };
    const { consumedTexts, result, settled } = await runWithAside("btw-command", (sessionId) =>
      runCommand(findCommand(commands, "btw")!, {
        argument: QUESTION,
        caller: null,
        session: {
          id: sessionId,
          cancel: async () => {},
          clear: async () => {},
          compact: async () => {},
          end: async () => {},
        },
      }),
    );

    expect(result).toEqual({ message: "It's building web-app." });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("which project");
    expect(asked[0]).toContain("web-app");
    expect(settled).toEqual(["completed"]);
    expect(consumedTexts).toEqual([TASK]);
  }, 90_000);
});
