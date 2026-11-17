import { describe, expect, it, vi } from "vitest";

import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { createModelMetadata } from "#internal/model-catalog.js";
import { auto } from "#models/auto.js";
import { defineModel, isModelDefinition, modelSignInName } from "#models/definition.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";
import type { EveLanguageModel } from "#shared/agent-definition.js";
import type { TokenResult } from "#shared/connection-types.js";

const create = (): EveLanguageModel => ({
  doGenerate: async () => ({}),
  doStream: async () => ({}),
  modelId: "claude-sonnet-5",
  provider: "anthropic",
  specificationVersion: "v4",
});
const getToken = async (): Promise<TokenResult> => ({ token: "t" });
const connectAuth = { getToken, vercelConnect: { connector: "anthropic/myagent" } };

describe("defineModel", () => {
  it("brands the definition and keys its sign-in by the connector", () => {
    const model = defineModel({ auth: connectAuth, create, id: "anthropic/claude-sonnet-5" });
    expect(isModelDefinition(model)).toBe(true);
    expect(isModelDefinition({ ...model })).toBe(false);
    expect(modelSignInName(model)).toBe("eve__model__anthropic_myagent");
  });

  it("keys the sign-in by authKey when given", () => {
    const model = defineModel({ auth: connectAuth, authKey: "byo", create, id: "a/b" });
    expect(modelSignInName(model)).toBe("eve__model__byo");
  });

  it.each([
    [
      "an empty id",
      { auth: connectAuth, create, id: " " },
      /"id" field must be a non-empty string/,
    ],
    ["a create that is not a function", { auth: connectAuth, create: "x", id: "a/b" }, /"create"/],
    ["an auth without getToken", { auth: {}, create, id: "a/b" }, /"auth.getToken"/],
    ["a per-caller auth function", { auth: () => connectAuth, create, id: "a/b" }, /"auth" field/],
    ["an auth without connector or authKey", { auth: { getToken }, create, id: "a/b" }, /authKey/],
    [
      "an authKey with other characters",
      { auth: { getToken }, authKey: "a/b", create, id: "a/b" },
      /"authKey" field must contain only/,
    ],
  ])("rejects %s", (_name, definition, message) => {
    expect(() => defineModel(definition as never)).toThrow(message);
  });
});

describe("where a model definition can't run", () => {
  const model = defineModel({ auth: connectAuth, create, id: "anthropic/claude-sonnet-5" });

  it("rejects it as compaction.model", () => {
    expect(() =>
      normalizeAgentDefinition({ compaction: { model }, model: "openai/gpt-5.5" }, "agent.ts:"),
    ).toThrow(/"compaction.model" takes a model ID or a model instance/);
  });

  it("rejects it as auto's decision model", () => {
    expect(() => auto({ model: model as never, options: { "openai/gpt-5.5": "Default" } })).toThrow(
      /decision model takes a model ID or a decision model instance/,
    );
  });

  it("rejects it where a selection must be serializable", async () => {
    await expect(
      resolveRuntimeModelSelection({
        durability: "durable",
        modelMetadata: vi.fn(),
        selection: model,
      }),
    ).rejects.toThrow(/durable model selections must be serializable/);
  });

  it("selects it live with the catalog's context window for its id", async () => {
    const metadata = createModelMetadata({
      catalog: {
        models: [
          {
            slug: "anthropic/claude-sonnet-5",
            providers: [
              {
                contextWindowTokens: 200_000,
                provider: "anthropic",
                providerModelId: "claude-sonnet-5",
              },
            ],
          },
        ],
        providerAliases: {},
      },
      fetchedAt: "2026-10-27T00:00:00.000Z",
    });
    const selection = await resolveRuntimeModelSelection({
      durability: "live",
      modelMetadata: async () => metadata,
      selection: { model, reasoning: "low" },
    });
    expect(selection.model).toBe(model);
    expect(selection.reference).toMatchObject({
      contextWindowTokens: 200_000,
      id: "anthropic/claude-sonnet-5",
      reasoning: "low",
    });
  });
});
