import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createChannelAddress } from "#channel/channel-address.js";
import type { Runtime } from "#channel/types.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createInProcessRuntime } from "#execution/in-process/runtime.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { textStreamResult } from "#internal/testing/approval-resume.js";
import { defineAgent } from "#public/definitions/agent.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

async function eventTypes(runtime: Runtime, sessionId: string): Promise<string[]> {
  const reader = (await runtime.getEventStream(sessionId, { follow: false })).getReader();
  const types: string[] = [];
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    types.push(next.value.type);
  }
  return types;
}

// About 140k tokens: over the threshold of a 150k window, well under a 1M one's.
const NOTES = "Alice's notes on the quarterly release. ".repeat(14_000);

/** How many compactions Alice's two turns start, for an agent whose model has `window`. */
async function compactions(input: { readonly dynamic: boolean; readonly window: number }) {
  const model = markMockModel(
    new MockLanguageModelV4({
      doStream: async () => textStreamResult("Noted."),
      modelId: "threshold-scripted",
      provider: "eve-test",
    }),
  );
  const test = await createTestRuntime({
    agent: {
      definition: input.dynamic
        ? defineAgent({
            model: defineDynamic(() => ({ model, modelContextWindowTokens: input.window })),
          })
        : defineAgent({ model, modelContextWindowTokens: input.window }),
      name: `threshold-${input.dynamic ? "dynamic" : "static"}`,
    },
  });
  return await test.run(async () => {
    const runtime = createInProcessRuntime({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    });
    const alice = createChannelAddress({
      adapter: { kind: "http" },
      channelName: "http",
      continuationToken: `alice-threshold-${Math.random()}`,
      runtime,
    });
    const first = await (await alice.send(NOTES, { auth: null })).result();
    await (await alice.send("And the second part?", { auth: null })).result();
    const types = await eventTypes(runtime, first.sessionId);
    return types.filter((type) => type === "context.started").length;
  });
}

describe("the compaction threshold", () => {
  it("is a share of a dynamic model's context window", async () => {
    expect(await compactions({ dynamic: true, window: 1_000_000 })).toBe(0);
    expect(await compactions({ dynamic: true, window: 150_000 })).toBeGreaterThan(0);
  }, 120_000);

  it("is a share of agent.ts's model's context window", async () => {
    expect(await compactions({ dynamic: false, window: 1_000_000 })).toBe(0);
    expect(await compactions({ dynamic: false, window: 150_000 })).toBeGreaterThan(0);
  }, 120_000);
});
