import { describe, expect, it, vi } from "vitest";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { runModelFlow, type CurrentAgentModel, type ModelFlowDeps } from "./model.js";

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
