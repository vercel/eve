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

import { MODEL_MENU_MESSAGE, runModelFlow, type ModelFlowDeps } from "./model.js";

const APP_ROOT = "/app/my-agent";

const CATALOG: GatewayCatalogModel[] = [
  {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    type: "language",
    owned_by: "anthropic",
    tags: ["web-search"],
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    type: "language",
    owned_by: "openai",
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
 * Answers the menu prompt from a script (throwing the cancel error for
 * "esc"), records every painted menu, and answers each catalog picker
 * prompt from the `picker` queue ("esc" cancels that picker).
 */
function scriptedPrompter(input: { menu: (PrompterValue | "esc")[]; picker?: string[] }) {
  const menuPaints: MenuPaint[] = [];
  const menuScript = [...input.menu];
  const pickerScript = [...(input.picker ?? [])];
  const fake = createFakePrompter({
    single: (opts: SingleSelectOptions<PrompterValue>) => {
      if (opts.message === MODEL_MENU_MESSAGE) {
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
      }
      const answer = pickerScript.shift();
      if (answer === undefined) {
        throw new Error(`Unexpected picker prompt: "${opts.message}"`);
      }
      if (answer === "esc") throw new WizardCancelledError();
      return answer;
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
            description: "The model your agent uses",
          },
          {
            value: "reasoning",
            label: "Reasoning",
            hint: "Provider default",
            description: "Effort level; exact support depends on the model and provider",
          },
          {
            value: "fast-mode",
            label: "Fast mode",
            hint: "Off (standard)",
            description: "Requests faster Gateway processing at increased cost",
          },
          {
            value: "provider",
            label: "Change provider",
            hint: `AI Gateway (Linked to ${pc.bold("my-agent")})`,
            description: "How your agent reaches the model provider",
          },
          { value: "done", label: "Done", description: "Return to the prompt" },
        ],
        notices: [],
        hintLayout: "stacked",
        initialValue: "model",
      },
    ]);
  });

  it("disables both rows for an external-provider model and never asks to configure a provider", async () => {
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
            disabled: true,
            description: "Set via an SDK model call in agent.ts; edit the source to change it",
          },
          {
            value: "reasoning",
            label: "Reasoning",
            hint: "Provider default",
            description: "Effort level; exact support depends on the model and provider",
          },
          {
            value: "fast-mode",
            label: "Fast mode",
            hint: "Off (standard)",
            disabled: true,
            description: "Disabled for a direct external provider",
          },
          {
            value: "provider",
            label: "Change provider",
            disabled: true,
            description: "Disabled in external endpoint mode",
          },
          { value: "done", label: "Done", description: "Return to the prompt" },
        ],
        notices: [
          {
            tone: "warning",
            text: "`agent.ts` specifies the model provider directly. Model, provider, and Fast mode changes stay source-owned; reasoning remains configurable here.",
          },
        ],
        hintLayout: "stacked",
        initialValue: "reasoning",
      },
    ]);
  });

  it("disables only Change model for a gateway-routed SDK model call, keeping the provider row", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
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
      detectProviderStatus: vi.fn(
        async () =>
          ({ kind: "gateway-key", envKey: "AI_GATEWAY_API_KEY", envFile: ".env.local" }) as const,
      ),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options).toEqual([
      {
        value: "model",
        label: "Change model",
        disabled: true,
        description: "Set via an SDK model call in agent.ts; edit the source to change it",
      },
      {
        value: "reasoning",
        label: "Reasoning",
        hint: "Provider default",
        description: "Effort level; exact support depends on the model and provider",
      },
      {
        value: "fast-mode",
        label: "Fast mode",
        hint: "Off (standard)",
        description: "Requests faster Gateway processing at increased cost",
      },
      {
        value: "provider",
        label: "Change provider",
        hint: "AI Gateway (AI_GATEWAY_API_KEY in .env.local)",
        description: "How your agent reaches the model provider",
      },
      { value: "done", label: "Done", description: "Return to the prompt" },
    ]);
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

    expect(menuPaints[0]?.options[3]).toEqual({
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

    expect(menuPaints[0]?.options[3]).toEqual({
      value: "provider",
      label: "Change provider",
      hint: "AI Gateway (AI_GATEWAY_API_KEY in .env.local)",
      description: "How your agent reaches the model provider",
    });
  });

  it("applies the model and returns to the prompt", async () => {
    const { prompter, menuPaints, selectMessages } = scriptedPrompter({
      menu: ["model", "done"],
      picker: ["openai/gpt-5.5"],
    });
    const deps = flowDeps();

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage: `Model changed to ${pc.bold("openai/gpt-5.5")}. Live on your next prompt.`,
    });

    expect(selectMessages).toEqual([
      MODEL_MENU_MESSAGE,
      "Which model should your agent use?",
      MODEL_MENU_MESSAGE,
    ]);
    expect(menuPaints).toHaveLength(2);
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
    const { prompter, menuPaints } = scriptedPrompter({
      menu: ["model", "done"],
      picker: ["openai/gpt-5.5"],
    });
    const deps = flowDeps({
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

  it("drafts reasoning and Fast mode, then applies both once on Done", async () => {
    const { prompter, menuPaints } = scriptedPrompter({
      menu: ["reasoning", "fast-mode", "done"],
      picker: ["high", "priority"],
    });
    const deps = flowDeps({
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

    expect(menuPaints).toHaveLength(3);
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

  it("discards a model-settings draft when the root menu is cancelled, and says so", async () => {
    const { prompter } = scriptedPrompter({
      menu: ["reasoning", "esc"],
      picker: ["low"],
    });
    const deps = flowDeps();

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
      discardedDraft: true,
    });
    expect(deps.applySettings).not.toHaveBeenCalled();
  });

  it("shows a custom Gateway service tier without allowing the binary toggle to erase it", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-5",
        routing: { kind: "gateway", target: "anthropic" } as const,
        reasoning: "medium" as const,
        serviceTier: { kind: "custom", value: "flex" } as const,
        editable: true,
        settingsEditable: true,
      })),
    });

    await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(menuPaints[0]?.options[2]).toEqual({
      value: "fast-mode",
      label: "Fast mode",
      hint: "Custom (flex)",
      description: "Custom service tier is authored in agent.ts; edit it there",
      disabled: true,
    });
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

    expect(runProviderFlow).toHaveBeenCalledWith(expect.objectContaining({ appRoot: APP_ROOT }));
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

  it("folds a cancelled picker without touching the source", async () => {
    const { prompter, menuPaints } = scriptedPrompter({
      menu: ["model", "esc"],
      picker: ["esc"],
    });
    const deps = flowDeps();

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });
    // The cancelled picker lands back on the menu before the empty exit.
    expect(menuPaints).toHaveLength(2);
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

      const model = scriptedPrompter({ menu: ["model", "esc"], picker: ["esc"] });
      await runModelFlow({ appRoot: APP_ROOT, prompter: model.prompter, deps: flowDeps() });
      expect(model.menuPaints[1]?.initialValue).toBe("model");
    });
  });
});
