import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";

describe("resolveRuntimeModelReference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves Codex auth on an OpenAI model id to a Codex-backed model", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const model = (await resolveRuntimeModelReference({
      id: "openai/gpt-5.4",
      transport: "codex",
    })) as LanguageModel;

    expect(model).toMatchObject({
      modelId: "gpt-5.4",
      provider: "codex.responses",
      specificationVersion: "v4",
    });
  });

  it("rejects Codex auth for non-OpenAI model ids", async () => {
    vi.stubEnv("NODE_ENV", "development");

    await expect(
      resolveRuntimeModelReference({
        id: "anthropic/claude-sonnet-4.6",
        transport: "codex",
      }),
    ).rejects.toThrow("Codex model auth requires an OpenAI model id");
  });

  it("does not intercept a model without the codex transport marker", async () => {
    vi.stubEnv("NODE_ENV", "development");

    // The codex transport is opted into via experimental.useCodexSubscription,
    // never inferred from a provider or id named "codex".
    const model = await resolveRuntimeModelReference({
      id: "codex/gpt-5.4",
    });

    expect(model).toBe("codex/gpt-5.4");
  });
});
