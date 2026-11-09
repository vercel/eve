import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import type { ActivationOutcome } from "#execution/entity/entities.js";
import { localWorld } from "#execution/world/local-world.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult, toolCallsStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { defineChannel, POST } from "#public/definitions/channel.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";
import { createWorldHost, type WorldHost } from "./host.js";

// An agent compiled from files, run by a World host: its sessions run only when something
// arrives for them, as a code agent's do, from the compiled artifacts this server bundles.

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

let dir: string;
let host: WorldHost | undefined;
const outcomes: { sessionId: string; outcome: ActivationOutcome }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eve-world-host-compiled-"));
  outcomes.length = 0;
});
afterEach(async () => {
  await host?.close();
  await host?.world.close?.();
  host = undefined;
  rmSync(dir, { force: true, recursive: true });
});

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("an agent compiled from files on a World host", () => {
  it("runs a turn with its tools when a message arrives, and stops when it waits", async () => {
    const looked: string[] = [];
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) =>
          prompt.some((message) => message.role === "tool")
            ? textStreamResult("It's sunny in Lisbon.")
            : toolCallsStreamResult([
                { input: '{"city":"Lisbon"}', toolCallId: "call-weather", toolName: "get_weather" },
              ]),
        modelId: "world-host-compiled",
        provider: "eve-test",
      }),
    );
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "weather",
      },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "The weather in a city.",
              inputSchema: {
                additionalProperties: false,
                properties: { city: { type: "string" } },
                required: ["city"],
                type: "object",
              },
              async execute(input: { readonly city: string }) {
                looked.push(input.city);
                return { city: input.city, condition: "Sunny" };
              },
            }),
          }),
          logicalPath: "tools/get_weather.ts",
        },
      ],
    });
    await test.run(async () => {
      host = createWorldHost({
        compiledAgents: { weather: createBundledRuntimeCompiledArtifactsSource() },
        observe: ({ outcome, sessionId }) => outcomes.push({ outcome, sessionId }),
        world: localWorld({ dataDir: join(dir, "world") }),
      });
      await host.serve();
      const session = await host.createSession("weather", { identity: alice });
      const done = await (await session.send("What's the weather in Lisbon?")).result();
      expect(done.reply).toBe("It's sunny in Lisbon.");
      expect(looked).toEqual(["Lisbon"]);
      await until(() => outcomes.at(-1)?.outcome.kind === "idle");

      // The next message is another activation, which continues the session from its World.
      const before = outcomes.length;
      const again = await (await session.send("And tomorrow?")).result();
      expect(again.sessionId).toBe(done.sessionId);
      await until(() => outcomes.length > before && outcomes.at(-1)?.outcome.kind === "idle");
    });
  }, 60_000);

  it("serves its channels: a thread's messages reach one session, each in an activation", async () => {
    const prompts: number[] = [];
    const model = markMockModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const users = prompt.filter((message) => message.role === "user").length;
          prompts.push(users);
          return textStreamResult(`Reply ${String(users)}.`);
        },
        modelId: "world-host-channel",
        provider: "eve-test",
      }),
    );
    const hello = defineChannel({
      routes: [
        POST("/hello/:thread", async (request, { from, params }) => {
          const { text } = (await request.json()) as { readonly text: string };
          const delivery = await from(params.thread!).send(text, { auth: alice });
          const done = await delivery.result();
          return Response.json({ reply: done.reply, sessionId: delivery.sessionId });
        }),
      ],
    });
    const test = await createTestRuntime({
      agent: {
        definition: defineAgent({
          model: defineDynamic(() => ({ model, modelContextWindowTokens: 200_000 })),
        }),
        name: "greeter",
      },
      modules: [
        { loadNamespace: async () => ({ default: hello }), logicalPath: "channels/hello.ts" },
      ],
    });
    await test.run(async () => {
      host = createWorldHost({
        compiledAgents: { greeter: createBundledRuntimeCompiledArtifactsSource() },
        observe: ({ outcome, sessionId }) => outcomes.push({ outcome, sessionId }),
        world: localWorld({ dataDir: join(dir, "world") }),
      });
      await host.serve();
      const serve = host.channels("greeter");
      const post = async (thread: string, text: string) =>
        (await (
          await serve(
            new Request(`http://greeter.local/hello/${thread}`, {
              body: JSON.stringify({ text }),
              headers: { "content-type": "application/json" },
              method: "POST",
            }),
          )
        ).json()) as { readonly reply: string; readonly sessionId: string };

      const first = await post("t1", "Hi.");
      expect(first.reply).toBe("Reply 1.");
      await until(() => outcomes.at(-1)?.outcome.kind === "idle");
      const before = outcomes.length;
      const second = await post("t1", "Again.");
      expect(second).toEqual({ reply: "Reply 2.", sessionId: first.sessionId });
      // It ran in an activation of its own, which ends once the reply went out.
      await until(() => outcomes.length > before && outcomes.at(-1)?.outcome.kind === "idle");
      // Another thread is another session.
      expect((await post("t2", "Hello.")).sessionId).not.toBe(first.sessionId);
      // A path no channel has is a 404.
      expect(
        (await serve(new Request("http://greeter.local/nope", { method: "POST" }))).status,
      ).toBe(404);
    });
  }, 60_000);
});
