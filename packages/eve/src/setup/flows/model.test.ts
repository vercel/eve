import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { runModelFlow, type CurrentAgentModel, type ModelFlowDeps } from "./model.js";

const provenance = vi.hoisted(() => ({ inspect: vi.fn(), authored: vi.fn(), models: vi.fn() }));
vi.mock("#services/inspect-application.js", () => ({ inspectApplication: provenance.inspect }));
vi.mock("./model-source-change.js", async (original) => ({
  ...(await original<typeof import("./model-source-change.js")>()),
  readAuthoredModelSelection: provenance.authored,
}));
vi.mock("#internal/model-auth/available-models.js", () => ({
  availableHelperModels: provenance.models,
}));

function deps(overrides: Partial<ModelFlowDeps> = {}): Partial<ModelFlowDeps> {
  return {
    readCurrentModel: vi.fn(async (): Promise<CurrentAgentModel> => ({
      id: "openai/gpt-5.6-luna-fast",
      routing: { kind: "gateway", target: "openai" },
      reasoning: null,
      serviceTier: { kind: "standard" },
      editable: true,
      settingsEditable: true,
    })),
    selectModel: { fetchModels: vi.fn(async () => []) },
    pickModelSettings: vi.fn(async () => ({ model: "anthropic/claude-sonnet-5" })),
    applySettings: vi.fn(async () => ({ kind: "changed", changed: ["model"] }) as const),
    ...overrides,
  };
}

describe("runModelFlow", () => {
  it("opens settings directly and applies a selection without a review or provider prompt", async () => {
    const fake = createFakePrompter();
    const flow = deps();
    const result = await runModelFlow({ appRoot: "/agent", prompter: fake.prompter, deps: flow });
    expect(fake.selectMessages).toEqual([]);
    expect(flow.applySettings).toHaveBeenCalledWith({
      appRoot: "/agent",
      patch: {
        model: { kind: "set", value: "anthropic/claude-sonnet-5" },
        reasoning: { kind: "keep" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
    expect(result).toMatchObject({ kind: "done", accessChanged: true });
  });
  it("cancels without touching authored settings", async () => {
    const flow = deps({ pickModelSettings: vi.fn(async () => undefined) });
    expect(
      await runModelFlow({
        appRoot: "/agent",
        prompter: createFakePrompter().prompter,
        deps: flow,
      }),
    ).toEqual({ kind: "cancelled" });
    expect(flow.applySettings).not.toHaveBeenCalled();
  });
  it("reports a rejected edit without claiming a change", async () => {
    const flow = deps({
      applySettings: vi.fn(
        async () => ({ kind: "rejected", message: "Edit agent.ts manually." }) as const,
      ),
    });
    expect(
      await runModelFlow({
        appRoot: "/agent",
        prompter: createFakePrompter().prompter,
        deps: flow,
      }),
    ).toEqual({ kind: "done", accessChanged: false, modelMessage: "Edit agent.ts manually." });
  });
  it("removes default reasoning and standard service tier rather than writing sentinels", async () => {
    const flow = deps({
      pickModelSettings: vi.fn(
        async () => ({ reasoning: "default", serviceTier: "standard" }) as const,
      ),
    });
    await runModelFlow({ appRoot: "/agent", prompter: createFakePrompter().prompter, deps: flow });
    expect(flow.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: {
          model: { kind: "keep" },
          reasoning: { kind: "remove" },
          gatewayServiceTier: { kind: "remove" },
        },
      }),
    );
  });
});

it.each(["openai", "anthropic"])(
  "keeps a foreign %s call fixed without requesting eve credentials",
  async (provider) => {
    provenance.models.mockClear();
    provenance.authored.mockResolvedValue(undefined);
    provenance.inspect.mockResolvedValue({
      compiledState: {
        manifest: {
          config: {
            source: {},
            model: { id: "custom-model", source: {}, routing: { kind: "external", provider } },
          },
        },
      },
    });
    const picker = vi.fn(async () => undefined);
    await runModelFlow({
      appRoot: "/agent",
      prompter: createFakePrompter().prompter,
      deps: { pickModelSettings: picker, selectModel: { fetchModels: async () => [] } },
    });
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ kind: "fixed", current: "custom-model" }),
      }),
    );
    expect(provenance.models).not.toHaveBeenCalled();
  },
);
it("loads a proven eve helper's model catalog", async () => {
  provenance.authored.mockResolvedValue("openai-api/custom-model");
  provenance.models.mockResolvedValue(["custom-model"]);
  provenance.inspect.mockResolvedValue({
    compiledState: {
      manifest: {
        config: {
          source: {},
          model: {
            id: "custom-model",
            source: {},
            routing: { kind: "external", provider: "openai" },
          },
        },
      },
    },
  });
  const picker = vi.fn(async () => undefined);
  await runModelFlow({
    appRoot: "/agent",
    prompter: createFakePrompter().prompter,
    deps: { pickModelSettings: picker, selectModel: { fetchModels: async () => [] } },
  });
  expect(provenance.models).toHaveBeenCalledWith("openai", undefined);
  expect(picker).toHaveBeenCalledWith(
    expect.objectContaining({
      model: expect.objectContaining({ kind: "pick", current: "openai-api/custom-model" }),
    }),
  );
});
