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
      auth: { kind: "codex" },
      id: "openai/gpt-5.4",
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
        auth: { kind: "codex" },
        id: "anthropic/claude-sonnet-4.6",
      }),
    ).rejects.toThrow("Codex model auth requires an OpenAI model id");
  });

  it("does not intercept an external provider named codex", async () => {
    vi.stubEnv("NODE_ENV", "development");

    // Codex transport is opted into via experimental.useCodexSubscription
    // (auth kind), never inferred from a provider or id named "codex".
    const model = await resolveRuntimeModelReference({
      auth: { kind: "external", provider: "codex" },
      id: "codex/gpt-5.4",
    });

    expect(model).toBe("codex/gpt-5.4");
  });
});
