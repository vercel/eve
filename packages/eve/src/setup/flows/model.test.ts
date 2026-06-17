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
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
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
      id: "anthropic/claude-sonnet-4.6",
      routing: { kind: "gateway", target: "anthropic" } as const,
      editable: true,
    })),
    applyModel: vi.fn(
      async ({ slug }: { appRoot: string; slug: string }) =>
        ({ kind: "changed", to: slug }) as const,
    ),
    selectModel: { fetchModels: async () => CATALOG },
    detectProviderStatus: vi.fn(async () => ({ kind: "unset" }) as const),
    runVercelFlow: vi.fn(async () => ({ kind: "done" }) as const),
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
  it("paints a stacked menu with the running model and a required provider row", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps: flowDeps() })).resolves.toEqual({
      kind: "cancelled",
    });

    expect(menuPaints).toEqual([
      {
        options: [
          { value: "model", label: "Change model", hint: "anthropic/claude-sonnet-4.6" },
          {
            value: "provider",
            label: pc.bold(pc.yellow("Configure provider")),
            hint: "Required to enable the agent",
            accent: "warning",
          },
          { value: "done", label: "Done" },
        ],
        notices: [],
        hintLayout: "stacked",
        // An unconfigured provider is what the agent needs first, so the menu
        // opens on that row.
        initialValue: "provider",
      },
    ]);
  });

  it("disables both rows for an external-provider model and never asks to configure a provider", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-4.6",
        routing: { kind: "external", provider: "anthropic" } as const,
        editable: false,
      })),
      // Even though detection finds nothing, external routing must NOT surface
      // the "Configure provider / Required" gateway UX.
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
            // Disabled because the model isn't a string literal, not because of routing.
            description: "Set via an SDK model call in agent.ts; edit the source to change it",
          },
          {
            value: "provider",
            label: "Change provider",
            disabled: true,
            description: "Disabled in external endpoint mode",
          },
          { value: "done", label: "Done" },
        ],
        // One yellow notice explains why both rows are inert.
        notices: [
          {
            tone: "warning",
            text: "`agent.ts` specifies a model provider directly. In-TUI configuration is restricted to AI Gateway endpoints.",
          },
        ],
        hintLayout: "stacked",
        // Both action rows are disabled, so the menu opens on Done.
        initialValue: "done",
      },
    ]);
  });

  it("disables only Change model for a gateway-routed SDK model call, keeping the provider row", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["esc"] });
    const deps = flowDeps({
      // `gateway("…")` instance: gateway-routed, but not a string literal eve can rewrite.
      readCurrentModel: vi.fn(async () => ({
        id: "anthropic/claude-sonnet-4.6",
        routing: { kind: "gateway", target: "anthropic" } as const,
        editable: false,
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
        value: "provider",
        label: "Change provider",
        hint: "AI Gateway (AI_GATEWAY_API_KEY in .env.local)",
      },
      { value: "done", label: "Done" },
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

    expect(menuPaints[0]?.options[1]).toEqual({
      value: "provider",
      label: "Change provider",
      hint: `AI Gateway (Linked to ${pc.bold("my-agent")} in ${pc.bold("my-team")})`,
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
    });
  });

  it("applies the model and returns to the prompt", async () => {
    const { prompter, menuPaints, selectMessages } = scriptedPrompter({
      menu: ["model"],
      picker: ["openai/gpt-5.5"],
    });
    const deps = flowDeps();

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage: `Model changed to ${pc.bold("openai/gpt-5.5")}. Live on your next prompt.`,
    });

    expect(selectMessages).toEqual([MODEL_MENU_MESSAGE, "Which model should your agent use?"]);
    expect(menuPaints).toHaveLength(1);
    expect(deps.applyModel).toHaveBeenCalledWith({ appRoot: APP_ROOT, slug: "openai/gpt-5.5" });
    expect(deps.readCurrentModel).toHaveBeenCalledTimes(1);
  });

  it("returns a rejection without repainting the menu", async () => {
    const { prompter, menuPaints } = scriptedPrompter({
      menu: ["model"],
      picker: ["openai/gpt-5.5"],
    });
    const deps = flowDeps({
      applyModel: vi.fn(
        async () => ({ kind: "rejected", message: "Couldn't confirm the id." }) as const,
      ),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      modelMessage: "Couldn't confirm the id.",
    });

    expect(menuPaints).toHaveLength(1);
  });

  it("returns to the prompt after provider setup", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["provider"] });
    const detectProviderStatus = vi
      .fn<ModelFlowDeps["detectProviderStatus"]>()
      .mockResolvedValueOnce({ kind: "unset" })
      .mockResolvedValueOnce({ kind: "gateway-project", projectName: "my-agent" });
    const runVercelFlow = vi.fn<ModelFlowDeps["runVercelFlow"]>(
      async () => ({ kind: "done", credential: "AI_GATEWAY_API_KEY" }) as const,
    );
    const deps = flowDeps({ detectProviderStatus, runVercelFlow });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "done",
      providerOutcome: {
        credential: "AI_GATEWAY_API_KEY",
        status: { kind: "gateway-project", projectName: "my-agent" },
      },
    });

    expect(runVercelFlow).toHaveBeenCalledWith(expect.objectContaining({ appRoot: APP_ROOT }));
    expect(detectProviderStatus).toHaveBeenCalledTimes(2);
    expect(menuPaints).toHaveLength(1);
  });

  it("treats the external-provider branch as informational — no notice, no outcome", async () => {
    const { prompter, menuPaints } = scriptedPrompter({ menu: ["provider", "esc"] });
    const deps = flowDeps({
      runVercelFlow: vi.fn(async () => ({ kind: "done", outcome: "external-provider" }) as const),
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
      runVercelFlow: vi.fn(async () => ({ kind: "cancelled" }) as const),
    });

    await expect(runModelFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });

    // A cancelled sub-flow changed nothing, so the status is not re-read.
    expect(deps.detectProviderStatus).toHaveBeenCalledTimes(1);
    expect(menuPaints).toHaveLength(2);
    expect(menuPaints[1]?.notices).toEqual([]);
    expect(deps.applyModel).not.toHaveBeenCalled();
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
    expect(deps.applyModel).not.toHaveBeenCalled();
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
        runVercelFlow: vi.fn(async () => ({ kind: "done", outcome: "external-provider" }) as const),
      });

      await runModelFlow({ appRoot: APP_ROOT, prompter, deps });

      expect(menuPaints[1]?.initialValue).toBe("done");
    });

    it("keeps the cursor on the row a cancelled sub-flow came from", async () => {
      const provider = scriptedPrompter({ menu: ["provider", "esc"] });
      await runModelFlow({
        appRoot: APP_ROOT,
        prompter: provider.prompter,
        deps: flowDeps({ runVercelFlow: vi.fn(async () => ({ kind: "cancelled" }) as const) }),
      });
      expect(provider.menuPaints[1]?.initialValue).toBe("provider");

      const model = scriptedPrompter({ menu: ["model", "esc"], picker: ["esc"] });
      await runModelFlow({ appRoot: APP_ROOT, prompter: model.prompter, deps: flowDeps() });
      expect(model.menuPaints[1]?.initialValue).toBe("model");
    });
  });
});
