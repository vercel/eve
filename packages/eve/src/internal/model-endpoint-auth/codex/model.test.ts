import { describe, expect, it } from "vitest";

import { createCodexSubscriptionModel } from "#internal/model-endpoint-auth/codex/model.js";

describe("Codex model", () => {
  it("creates an OpenAI Responses model under the Codex provider namespace", () => {
    const model = createCodexSubscriptionModel(
      { model: " gpt-5.4 " },
      {
        fetch: async () => Response.json({ ok: true }),
        readCredentials: async () => ({
          kind: "api-key",
          apiKey: "sk-test",
          authPath: "/home/user/.codex/auth.json",
          codexHome: "/home/user/.codex",
        }),
      },
    );

    expect(model).toMatchObject({
      modelId: "gpt-5.4",
      provider: "codex.responses",
      specificationVersion: "v4",
    });
  });

  it("rejects an empty Codex model id", () => {
    expect(() => createCodexSubscriptionModel({ model: " " })).toThrow(
      'Expected "model" to name a Codex model.',
    );
  });
});
