import pc from "picocolors";
import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { GatewayCatalogModel } from "#setup/boxes/select-model.js";
import type {
  PrompterValue,
  SelectNotice,
  SelectOption,
  SingleSelectOptions,
} from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";

import {
  MODEL_MENU_MESSAGE,
  runModelFlow,
  type ModelFlowDeps,
  type ModelSettingsRequest,
} from "./model.js";

const APP_ROOT = "/app/my-agent";

const CATALOG: GatewayCatalogModel[] = [
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    type: "language",
    owned_by: "anthropic",
    tags: ["reasoning", "web-search"],
    pricing: { service_tiers: { priority: {} } },
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    type: "language",
    owned_by: "openai",
    tags: ["reasoning", "web-search"],
    pricing: { service_tiers: { priority: {} } },
  },
  // Advertises neither the reasoning tag nor a priority tier, so capability
  // lookups have a catalog-listed model with no adjustable controls.
  {
    id: "test/no-frills",
    name: "No Frills",
    type: "language",
    owned_by: "test",
    tags: ["web-search"],
  },
];

function flowDeps(overrides: Partial<ModelFlowDeps> = {}): Partial<ModelFlowDeps> {
  return {
    readCurrentModel: vi.fn(async () => ({
      id: "anthropic/claude-sonnet-5",
      routing: { kind: "gateway", target: "anthropic" } as const,
      reasoning: null,
      serviceTier: { kind: "standard" } as const,
      editable: true,
      settingsEditable: true,
    })),
    applySettings: vi.fn(
      async ({ patch }: Parameters<ModelFlowDeps["applySettings"]>[0]) =>
        ({
          kind: "changed",
          changed: ["model"],
          model: patch.model.kind === "set" ? patch.model.value : undefined,
        }) as const,
    ),
    selectModel: { fetchModels: async () => CATALOG },
    pickModelSettings: vi.fn(async () => undefined),
    detectProviderStatus: vi.fn(
      async () => ({ kind: "gateway-project", projectName: "my-agent" }) as const,
    ),
    runProviderFlow: vi.fn(async () => ({ kind: "done" }) as const),
    ...overrides,
  };
}

/** One painted menu: its option rows plus the notice lines shown with them. */
interface MenuPaint {
  options: SelectOption<PrompterValue>[];
  notices: readonly SelectNotice[];
  hintLayout: string | undefined;
  /** The row the menu opened on (cursor pre-selection) for that lap. */
  initialValue: PrompterValue | undefined;
}

/**
 * Answers the root menu from a script (throwing the cancel error for "esc")
 * and records every painted menu. The composite model screen is not a prompter
 * question — tests script it through the `pickModelSettings` dep instead.
 */
function scriptedPrompter(input: { menu: (PrompterValue | "esc")[] }) {
  const menuPaints: MenuPaint[] = [];
  const menuScript = [...input.menu];
  const fake = createFakePrompter({
    single: (opts: SingleSelectOptions<PrompterValue>) => {
      if (opts.message !== MODEL_MENU_MESSAGE) {
        throw new Error(`Unexpected prompt: "${opts.message}"`);
      }
      menuPaints.push({
        options: opts.options,
        notices: opts.notices ?? [],
        hintLayout: opts.hintLayout,
        initialValue: opts.initialValue,
      });
      const next = menuScript.shift();
      if (next === undefined) throw new Error("Menu painted more times than scripted.");
      if (next === "esc") throw new WizardCancelledError();
      return next;
    },
  });
  return { ...fake, menuPaints };
}

describe("runModelFlow", () => {
  it("paints a stacked menu with the running model and configured provider", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps: flowDeps() })).resolves.toEqual({
      kind: "cancelled",
    });

    expect(menuPaints).toEqual([
      {
        options: [
          {
            value: "model",
            label: "Change model",
            hint: "anthropic/claude-sonnet-5",
            description: "The model, its reasoning effort, and the Gateway service tier",
          },
          {
            value: "provider",
            label: "Change provider",
            hint: `AI Gateway (Linked to ${pc.bold("my-agent")})`,
            description: "How your agent reaches the model provider",
          },
          { value: "done", label: "Done" },
        ],
        notices: [],
        hintLayout: "stacked",
        initialValue: "model",
      },
    ]);
  });

  it("summarizes authored reasoning and Fast mode on the model row hint", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "xai/grok-4.5",
        routing: { kind: "gateway", target: "xai" } as const,
        reasoning: "high" as const,
        serviceTier: { kind: "priority" } as const,
        editable: true,
        settingsEditable: true,
      })),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options[0]?.hint).toBe("xai/grok-4.5@high ↯");
  });

  it("keeps the model row for an external-provider model and never asks to configure a provider", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "external", provider: "anthropic" } as const,
        reasoning: null,
        serviceTier: { kind: "standard" } as const,
        editable: false,
        settingsEditable: true,
      })),
      // Even though detection finds nothing, external routing must NOT surface
      // the "Configure model access" gateway UX.
      detectProviderStatus: vi.fn(async () => ({ kind: "unset" }) as const),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });

    expect(menuPaints).toEqual([
      {
        options: [
          {
            value: "model",
            label: "Change model",
            hint: "anthropic/claude-sonnet-5",
            description:
              "Reasoning and service tier; the model itself is an SDK model call in agent.ts",
          },
          {
            value: "provider",
            label: "Change provider",
            disabled: true,
            description: "Disabled in external endpoint mode",
          },
          { value: "done", label: "Done" },
        ],
        notices: [
          {
            tone: "warning",
            text: "`agent.ts` specifies the model provider directly. Model, provider, and service-tier changes stay source-owned; reasoning remains configurable here.",
          },
        ],
        hintLayout: "stacked",
        initialValue: "model",
      },
    ]);
  });

  it("disables the Change model row only when nothing at all is editable", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" } as const,
        reasoning: null,
        serviceTier: { kind: "standard" } as const,
        editable: false,
        settingsEditable: false,
      })),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options[0]).toEqual({
      value: "model",
      label: "Change model",
      disabled: true,
      description: "Set via an SDK model call in agent.ts; edit the source to change it",
    });
    expect(menuPaints[0]?.initialValue).toBe("provider");
  });

  it("opens the composite screen with catalog options, authored values, and capabilities", async () => {
    const { prompter } = scriptedPrompter({ menu: ["model", "esc"] });
    let captured: ModelSettingsRequest | undefined;
    const pickModelSettings = vi.fn(async (request: ModelSettingsRequest) => {
      captured = request;
      return undefined;
    });
    const deps = flowDeps({ pickModelSettings });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(captured?.model).toEqual({
      kind: "pick",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "anthropic/claude-sonnet-5", featured: true }),
        expect.objectContaining({ value: "test/no-frills" }),
      ]),
      current: "anthropic/claude-sonnet-5",
    });
    expect(captured?.reasoning).toBeNull();
    expect(captured?.serviceTier).toEqual({ kind: "standard" });
    expect(captured?.settingsEditable).toBe(true);
    expect(captured?.externalRouting).toBe(false);
    expect(captured?.capabilitiesFor("test/no-frills")).toEqual({
      reasoning: false,
      reasoningLevels: [],
      fastMode: false,
    });
    expect(captured?.capabilitiesFor("unknown/model")).toBeUndefined();
  });

  it("fixes the model section for a gateway-routed SDK model call", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["model", "esc"] });
    let captured: ModelSettingsRequest | undefined;
    const deps = flowDeps({
      // `gateway("…")` instance: gateway-routed, but not a string literal eve can rewrite.
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" } as const,
        reasoning: null,
        serviceTier: { kind: "standard" } as const,
        editable: false,
        settingsEditable: true,
      })),
      pickModelSettings: vi.fn(async (request: ModelSettingsRequest) => {
        captured = request;
        return undefined;
      }),
      detectProviderStatus: vi.fn(
        async () =>
          ({ kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", envFile: ".env.local" }) as const,
      ),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(captured?.model).toEqual({
      kind: "fixed",
      current: "anthropic/claude-sonnet-5",
      reason: "Set via an SDK model call in agent.ts; edit the source to change it",
    });
    // Gateway routing gets no external-restriction notice.
    expect(menuPaints[0]?.notices).toEqual([]);
  });

  it("leaves via the Done row exactly like Esc", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["done"] });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps: flowDeps() })).resolves.toEqual({
      kind: "cancelled",
    });
    expect(menuPaints).toHaveLength(1);
  });

  it("names the linked project on the provider row once a provider is set", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      detectProviderStatus: vi.fn(
        async () =>
          ({ kind: "gateway-project", projectName: "my-agent", teamName: "my-team" }) as const,
      ),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options[1]).toEqual({
      value: "provider",
      label: "Change provider",
      hint: `AI Gateway (Linked to ${pc.bold("my-agent")} in ${pc.bold("my-team")})`,
      description: "How your agent reaches the model provider",
    });
  });

  it("names the credential env file when a gateway key is set without a link", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      detectProviderStatus: vi.fn(
        async () =>
          ({
            kind: "gateway-key",
            envKey: "AI_GATEWAY_API_KEY",
            envFile: ".env.local",
          }) as const,
      ),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options[1]).toEqual({
      value: "provider",
      label: "Change provider",
      hint: "AI Gateway (AI_GATEWAY_API_KEY in .env.local)",
      description: "How your agent reaches the model provider",
    });
  });

  it("applies a picked model once on Done and returns to the prompt", async () => {
    const { prompter, menuPaints, selectMessages } = scriptedPrompter({
      menu: ["model", "done"],
    });
    const deps = flowDeps({
      pickModelSettings: vi.fn(async () => ({ model: "openai/gpt-5.5" })),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage: `Model changed to ${pc.bold("openai/gpt-5.5")}. Live on your next prompt.`,
    });

    expect(selectMessages).toEqual([MODEL_MENU_MESSAGE, MODEL_MENU_MESSAGE]);
    expect(menuPaints).toHaveLength(2);
    // The second lap lands on Done and shows the drafted slug on the hint.
    expect(menuPaints[1]?.initialValue).toBe("done");
    expect(menuPaints[1]?.options[0]?.hint).toBe("openai/gpt-5.5");
    expect(deps.applySettings).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      patch: {
        model: { kind: "set", value: "openai/gpt-5.5" },
        reasoning: { kind: "keep" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
    expect(deps.readCurrentModel).toHaveBeenCalledTimes(1);
  });

  it("returns a rejected model result without claiming the model changed", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["model", "done"] });
    const deps = flowDeps({
      pickModelSettings: vi.fn(async () => ({ model: "openai/gpt-5.5" })),
      applySettings: vi.fn(
        async () => ({ kind: "rejected", message: "Couldn't confirm the id." }) as const,
      ),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage: "Couldn't confirm the id.",
    });

    expect(menuPaints).toHaveLength(2);
  });

  it("drafts reasoning and Fast mode from the screen, then applies both once on Done", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["model", "done"] });
    const deps = flowDeps({
      pickModelSettings: vi.fn(async () => ({
        reasoning: "high" as const,
        serviceTier: "priority" as const,
      })),
      applySettings: vi.fn<ModelFlowDeps["applySettings"]>(async () => ({
        kind: "changed" as const,
        changed: ["reasoning", "fast-mode"] as const,
        reasoning: "high" as const,
        fastMode: true,
      })),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage:
        "Model settings updated: reasoning high, Fast mode on. Live on your next prompt.",
    });

    expect(menuPaints).toHaveLength(2);
    expect(menuPaints[1]?.options[0]?.hint).toBe("anthropic/claude-sonnet-5@high ↯");
    expect(deps.applySettings).toHaveBeenCalledTimes(1);
    expect(deps.applySettings).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      patch: {
        model: { kind: "keep" },
        reasoning: { kind: "set", value: "high" },
        gatewayServiceTier: { kind: "set", value: "priority" },
      },
    });
  });

  it("maps the remove sentinels onto remove patches", async () => {
    const { prompter } = scriptedPrompter({ menu: ["model", "done"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" } as const,
        reasoning: "high" as const,
        serviceTier: { kind: "priority" } as const,
        editable: true,
        settingsEditable: true,
      })),
      pickModelSettings: vi.fn(async () => ({
        reasoning: "default" as const,
        serviceTier: "standard" as const,
      })),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(deps.applySettings).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      patch: {
        model: { kind: "keep" },
        reasoning: { kind: "remove" },
        gatewayServiceTier: { kind: "remove" },
      },
    });
  });

  it("discards a model-settings draft when the root menu is cancelled, and says so", async () => {
    const { prompter } = scriptedPrompter({ menu: ["model", "esc"] });
    const deps = flowDeps({
      pickModelSettings: vi.fn(async () => ({ reasoning: "low" as const })),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
      discardedDraft: true,
    });
    expect(deps.applySettings).not.toHaveBeenCalled();
  });

  it("passes a custom Gateway service tier through to the screen untouched", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["model", "esc"] });
    let captured: ModelSettingsRequest | undefined;
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" } as const,
        reasoning: "medium" as const,
        serviceTier: { kind: "custom", value: "flex" } as const,
        editable: true,
        settingsEditable: true,
      })),
      pickModelSettings: vi.fn(async (request: ModelSettingsRequest) => {
        captured = request;
        return undefined;
      }),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(captured?.serviceTier).toEqual({ kind: "custom", value: "flex" });
    // A custom tier is not Fast mode: no marker on the root hint.
    expect(menuPaints[0]?.options[0]?.hint).toBe("anthropic/claude-sonnet-5@medium");
  });

  it("folds an unchanged screen and a Done exit into a cancel", async () => {
    const { prompter } = scriptedPrompter({ menu: ["model", "done"] });
    const deps = flowDeps({ pickModelSettings: vi.fn(async () => ({})) });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });
    expect(deps.applySettings).not.toHaveBeenCalled();
  });

  it("opens provider setup directly when none is configured", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: [] });
    const detectProviderStatus = vi
      .fn<ModelFlowDeps["detectProviderStatus"]>()
      .mockResolvedValueOnce({ kind: "unset" })
      .mockResolvedValueOnce({ kind: "gateway-project", projectName: "my-agent" });
    const runProviderFlow = vi.fn<ModelFlowDeps["runProviderFlow"]>(
      async () => ({ kind: "done", credential: "AI_GATEWAY_API_KEY" }) as const,
    );
    const deps = flowDeps({ detectProviderStatus, runProviderFlow });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      providerOutcome: {
        credential: "AI_GATEWAY_API_KEY",
        status: { kind: "gateway-project", projectName: "my-agent" },
      },
    });

    // The sub-flow learns the detected provider so its menu can mark the active row.
    expect(runProviderFlow).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: APP_ROOT, currentProvider: { kind: "unset" } }),
    );
    expect(detectProviderStatus).toHaveBeenCalledTimes(2);
    expect(menuPaints).toHaveLength(0);
  });

  it("honors confirmed provider entry when link metadata looks configured", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: [] });
    const runProviderFlow = vi.fn<ModelFlowDeps["runProviderFlow"]>(
      async () => ({ kind: "done", credential: "VERCEL_OIDC_TOKEN" }) as const,
    );
    const deps = flowDeps({ runProviderFlow });

    await expect(
      runModelFlow({
        appRoot: APP_ROOT,
        prompter,
        initialStep: "provider",
        deps,
      }),
    ).resolves.toEqual({
      kind: "done",
      providerOutcome: {
        credential: "VERCEL_OIDC_TOKEN",
        status: { kind: "gateway-project", projectName: "my-agent" },
      },
    });

    expect(runProviderFlow).toHaveBeenCalledWith(expect.objectContaining({ appRoot: APP_ROOT }));
    expect(menuPaints).toHaveLength(0);
  });

  it("refreshes provider state after a committed setup is interrupted", async () => {
    const { prompter } = scriptedPrompter({ menu: [] });
    const controller = new AbortController();
    const detectProviderStatus = vi
      .fn<ModelFlowDeps["detectProviderStatus"]>()
      .mockResolvedValueOnce({ kind: "gateway-project", projectName: "my-agent" })
      .mockResolvedValueOnce({
        kind: "gateway-key",
        envKey: "AI_GATEWAY_API_KEY",
        envFile: ".env.local",
      });
    const runProviderFlow = vi.fn<ModelFlowDeps["runProviderFlow"]>(async () => {
      controller.abort();
      return { kind: "done", credential: "AI_GATEWAY_API_KEY" };
    });
    const deps = flowDeps({ detectProviderStatus, runProviderFlow });

    await expect(
      runModelFlow({
        appRoot: APP_ROOT,
        prompter,
        initialStep: "provider",
        signal: controller.signal,
        deps,
      }),
    ).resolves.toEqual({
      kind: "done",
      providerOutcome: {
        credential: "AI_GATEWAY_API_KEY",
        status: {
          kind: "gateway-key",
          envKey: "AI_GATEWAY_API_KEY",
          envFile: ".env.local",
        },
      },
    });
    expect(detectProviderStatus.mock.calls[1]?.[1]).toEqual({});
  });

  it("treats the external-provider branch as informational — no notice, no outcome", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["provider", "esc"] });
    const deps = flowDeps({
      runProviderFlow: vi.fn(async () => ({ kind: "external-provider" }) as const),
    });

    // Nothing changed on disk (any existing gateway link is untouched), so
    // the lap leaves no trace and the empty exit folds to cancelled.
    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });

    expect(deps.detectProviderStatus).toHaveBeenCalledTimes(1);
    expect(menuPaints[1]?.notices).toEqual([]);
  });

  it("returns to the menu after a cancelled sub-flow and folds an empty exit", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["provider", "esc"] });
    const deps = flowDeps({
      runProviderFlow: vi.fn(async () => ({ kind: "cancelled" }) as const),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });

    // A cancelled sub-flow changed nothing, so the status is not re-read.
    expect(deps.detectProviderStatus).toHaveBeenCalledTimes(1);
    expect(menuPaints).toHaveLength(2);
    expect(menuPaints[1]?.notices).toEqual([]);
    expect(deps.applySettings).not.toHaveBeenCalled();
  });

  describe("cursor pre-selection", () => {
    it("opens on the model row when a provider is already set", async () => {
      const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
      const deps = flowDeps({
        detectProviderStatus: vi.fn(
          async () => ({ kind: "gateway-project", projectName: "my-agent" }) as const,
        ),
      });

      await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

      expect(menuPaints[0]?.initialValue).toBe("model");
    });

    it("lands on Done after the external-provider branch", async () => {
      const { prompter, menuPaints } = scriptedPrompter({ menu: ["provider", "esc"] });
      const deps = flowDeps({
        runProviderFlow: vi.fn(async () => ({ kind: "external-provider" }) as const),
      });

      await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

      expect(menuPaints[1]?.initialValue).toBe("done");
    });

    it("keeps the cursor on the row a cancelled sub-flow came from", async () => {
      const provider = scriptedPrompter({ menu: ["provider", "esc"] });
      await runModelFlow({
        appRoot: APP_ROOT,
        prompter: provider.prompter,
        deps: flowDeps({ runProviderFlow: vi.fn(async () => ({ kind: "cancelled" }) as const) }),
      });
      expect(provider.menuPaints[1]?.initialValue).toBe("provider");

      const model = scriptedPrompter({ menu: ["model", "esc"] });
      await runModelFlow({ appRoot: APP_ROOT, prompter: model.prompter, deps: flowDeps() });
      expect(model.menuPaints[1]?.initialValue).toBe("model");
    });
  });
});
