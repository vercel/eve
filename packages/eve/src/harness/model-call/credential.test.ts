import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { credentialedModel } from "#harness/model-call/credential.js";
import { markMockModel } from "#internal/mock-model-identity.js";
import { defineModel } from "#models/definition.js";
import type { TokenResult } from "#shared/connection-types.js";

function providerModel(token: string) {
  return markMockModel(
    new MockLanguageModelV4({
      doGenerate: async () => {
        if (token === "stale") throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
        return {
          content: [{ text: `answered with ${token}`, type: "text" as const }],
          finishReason: { raw: undefined, unified: "stop" as const },
          usage: {
            inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
            outputTokens: { reasoning: undefined, text: 1, total: 1 },
          },
          warnings: [],
        };
      },
      modelId: "claude-sonnet-5",
      provider: "anthropic.messages",
    }),
  );
}

describe("credentialedModel", () => {
  it("builds the model from the credential and keeps its identity", async () => {
    const create = vi.fn(({ token }: TokenResult) => providerModel(token));
    const model = defineModel({
      auth: { getToken: async () => ({ token: "fresh" }) },
      authKey: "billing",
      create,
      id: "billing/claude",
    });
    const wrapped = await credentialedModel(model);
    expect(create).toHaveBeenCalledWith({ token: "fresh" });
    expect(wrapped).toMatchObject({ modelId: "claude-sonnet-5", provider: "anthropic.messages" });
  });
});
