import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompiledModuleMap } from "#compiler/module-map.js";
import { experimental_codex } from "#shared/codex-subscription-model.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";

const mocks = vi.hoisted(() => ({
  loadResolvedModuleExport: vi.fn(),
}));

vi.mock("#runtime/resolve-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadResolvedModuleExport: mocks.loadResolvedModuleExport,
}));

describe("resolveRuntimeModelReference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.loadResolvedModuleExport.mockReset();
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

    // The codex transport is opted into via an experimental_codex model value,
    // never inferred from a provider or id named "codex".
    const model = await resolveRuntimeModelReference({
      id: "codex/gpt-5.4",
    });

    expect(model).toBe("codex/gpt-5.4");
  });

  it("unwraps the experimental_codex fallback for a source-backed production model", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const fallback: LanguageModel = "anthropic/claude-sonnet-4.6";
    mocks.loadResolvedModuleExport.mockResolvedValue({
      model: experimental_codex("gpt-5.5", fallback),
    });

    const model = await resolveRuntimeModelReference(
      {
        id: "anthropic/claude-sonnet-4.6",
        source: { sourceKind: "module", logicalPath: "agent.ts", sourceId: "agent.ts" },
      },
      { moduleMap: {} as CompiledModuleMap, nodeId: undefined },
    );

    expect(model).toBe(fallback);
  });

  it("rejects a source-backed experimental_codex model without a fallback", async () => {
    vi.stubEnv("NODE_ENV", "development");

    mocks.loadResolvedModuleExport.mockResolvedValue({
      model: experimental_codex("gpt-5.5"),
    });

    await expect(
      resolveRuntimeModelReference(
        {
          id: "openai/gpt-5.5",
          source: { sourceKind: "module", logicalPath: "agent.ts", sourceId: "agent.ts" },
        },
        { moduleMap: {} as CompiledModuleMap, nodeId: undefined },
      ),
    ).rejects.toThrow("deployable fallback model");
  });
});
