import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";

import { buildStepHooks } from "#harness/step-hooks.js";
import type { HarnessSession } from "#harness/types.js";

describe("buildStepHooks", () => {
  it("uses the stable eve session id as the Codex prompt cache key", async () => {
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "gpt-5.6-luna" },
        system: "",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "continuation-test",
      history: [],
      sessionId: "session-cache-affinity",
    };
    const input = {
      cachePath: { kind: "none" as const },
      emissionState: {} as never,
      model: {
        modelId: "gpt-5.6-luna",
        provider: "codex.responses",
        specificationVersion: "v4",
      } as unknown as LanguageModel,
      session,
    };
    const hooks = buildStepHooks(input);

    await expect(hooks.prepareStep({ messages: [] } as never)).resolves.toMatchObject({
      providerOptions: {
        openai: { promptCacheKey: "session-cache-affinity" },
      },
    });
  });
});
