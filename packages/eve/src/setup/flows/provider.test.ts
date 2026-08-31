import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";
import { HumanActionRequiredError } from "#setup/human-action.js";

import {
  EXTERNAL_PROVIDER_INSTRUCTIONS,
  EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
  PROVIDER_QUESTION,
  runProviderFlow,
  type ProviderFlowDeps,
  type ProviderPicker,
} from "./provider.js";

const APP_ROOT = "/app/my-agent";

function createDeps() {
  return {
    getVercelAuthStatus: vi.fn(async (): Promise<VercelAuthStatus> => "authenticated"),
    runLinkFlow: vi.fn<ProviderFlowDeps["runLinkFlow"]>(async () => ({
      kind: "done",
    })),
    appendEnv: vi.fn<ProviderFlowDeps["appendEnv"]>(async () => ({
      written: ["AI_GATEWAY_API_KEY"],
      skipped: [],
    })),
    validateGatewayApiKey: vi.fn<ProviderFlowDeps["validateGatewayApiKey"]>(async () => ({
      kind: "valid",
    })),
  };
}

type ProviderFlowInput = Parameters<typeof runProviderFlow>[0];

function runTestProviderFlow(
  input: Omit<ProviderFlowInput, "availableProviders" | "selectedProvider"> &
    Partial<Pick<ProviderFlowInput, "availableProviders" | "selectedProvider">>,
) {
  return runProviderFlow({
    availableProviders: ["chatgpt", "ai-gateway-project"],
    selectedProvider: "ai-gateway-project",
    ...input,
  });
}

describe("runProviderFlow", () => {
  it("hands the Dev TUI one menu and lets the active project be replaced", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.message).toBe(PROVIDER_QUESTION);
      expect(request.options.map((option) => option.value)).toEqual([
        "ai-gateway-project",
        "ai-gateway-key",
        "chatgpt",
        "external",
      ]);
      expect(request.options[2]).toMatchObject({
        value: "chatgpt",
        label: "ChatGPT subscription",
      });
      expect(request.options[3]).toMatchObject({
        value: "external",
        label: "Other providers",
      });
      expect(request.initialValue).toBe("ai-gateway-project");
      return { kind: "ai-gateway-project" };
    };

    const result = await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      deps,
    });

    expect(result).toEqual({ kind: "ai-gateway-project" });
    expect(deps.runLinkFlow).toHaveBeenCalledExactlyOnceWith({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      projectSelection: "create-or-link",
    });
  });

  it("returns ChatGPT without touching Gateway setup", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    const result = await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async (request) => {
        expect(request.options.map((option) => option.value)).toEqual([
          "ai-gateway-project",
          "ai-gateway-key",
          "chatgpt",
          "external",
        ]);
        return { kind: "chatgpt" };
      },
      deps,
    });

    expect(result).toEqual({ kind: "chatgpt" });
    expect(deps.getVercelAuthStatus).not.toHaveBeenCalled();
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
    expect(deps.appendEnv).not.toHaveBeenCalled();
  });

  it("selects an available linked project without opening the link flow", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    const result = await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async () => ({ kind: "ai-gateway-project" }),
      selectedProvider: "chatgpt",
      deps,
    });

    expect(result).toEqual({ kind: "ai-gateway-project" });
    expect(deps.getVercelAuthStatus).not.toHaveBeenCalled();
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });

  it("checks and describes the active provider, opening the cursor on it", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const linked: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("ai-gateway-project");
      expect(request.options[0]).toMatchObject({
        value: "ai-gateway-project",
        checked: true,
        hint: "Current",
      });
      expect(request.options[1]?.checked).toBeUndefined();
      return undefined;
    };
    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: linked,
      selectedProvider: "ai-gateway-project",
      deps,
    });

    const keyed: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("ai-gateway-key");
      expect(request.options[1]).toMatchObject({
        value: "ai-gateway-key",
        checked: true,
        hint: "Current",
      });
      return undefined;
    };
    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: keyed,
      selectedProvider: "ai-gateway-key",
      deps,
    });
  });

  it("does not mark an inferred provider as current during onboarding", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("ai-gateway-project");
      expect(request.options.every((option) => option.checked !== true)).toBe(true);
      expect(request.options.every((option) => option.hint !== "Current")).toBe(true);
      return undefined;
    };

    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      selectedProvider: "ai-gateway-project",
      selectionExplicit: false,
      deps,
    });
  });

  it("uses the stored selection when multiple providers are available", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("ai-gateway-project");
      expect(request.options.find((option) => option.value === "ai-gateway-project")?.checked).toBe(
        true,
      );
      expect(
        request.options.find((option) => option.value === "ai-gateway-key")?.checked,
      ).toBeUndefined();
      return undefined;
    };

    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      selectedProvider: "ai-gateway-project",
      deps,
    });
  });

  it("repairs a missing CLI and login in place before linking", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    deps.getVercelAuthStatus
      .mockResolvedValueOnce("cli-missing")
      .mockResolvedValueOnce("logged-out")
      .mockResolvedValueOnce("authenticated");
    const actions: string[] = [];

    await expect(
      runTestProviderFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        picker: async () => ({ kind: "ai-gateway-project" }),
        recoverHumanAction: async (error) => {
          actions.push(error.action.kind);
          return "retry";
        },
        deps,
      }),
    ).resolves.toEqual({ kind: "ai-gateway-project" });

    expect(actions).toEqual(["vercel-cli-missing", "vercel-login"]);
    expect(deps.runLinkFlow).toHaveBeenCalledOnce();
  });

  it("repairs a link-time Vercel capability and resumes the same link", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    deps.runLinkFlow
      .mockRejectedValueOnce(
        new HumanActionRequiredError({
          kind: "vercel-cli-upgrade",
          command: "vercel upgrade",
          reason: "The CLI cannot list teams.",
        }),
      )
      .mockResolvedValueOnce({ kind: "done" });
    const recoverHumanAction = vi.fn(async () => "retry" as const);

    await expect(
      runTestProviderFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        picker: async () => ({ kind: "ai-gateway-project" }),
        recoverHumanAction,
        deps,
      }),
    ).resolves.toEqual({ kind: "ai-gateway-project" });

    expect(recoverHumanAction).toHaveBeenCalledOnce();
    expect(deps.runLinkFlow).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation from the project link flow", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    deps.runLinkFlow.mockResolvedValueOnce({ kind: "cancelled" });

    await expect(
      runTestProviderFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        picker: async () => ({ kind: "ai-gateway-project" }),
        deps,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  it("opens on ChatGPT when it is the selected provider", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("chatgpt");
      expect(request.options.find((option) => option.value === "chatgpt")).toMatchObject({
        checked: true,
        hint: "Current",
      });
      return undefined;
    };

    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      selectedProvider: "chatgpt",
      deps,
    });
  });

  it("reports a committed key as one set line", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async () => ({
        kind: "ai-gateway-key",
        key: "sk-inline",
        validation: { kind: "valid" },
      }),
      deps,
    });

    expect(fake.prompter.log.success).toHaveBeenCalledExactlyOnceWith("AI_GATEWAY_API_KEY set.");
  });

  it("persists the accepted inline key and does not revalidate it after submission", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      const signal = new AbortController().signal;
      const validation = await request.validateInlineKey("sk-inline", signal);
      if (validation.kind === "invalid") throw new Error(validation.message);
      return { kind: "ai-gateway-key", key: "sk-inline", validation };
    };

    const result = await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      deps,
    });

    expect(result).toEqual({ kind: "ai-gateway-key" });
    expect(deps.validateGatewayApiKey).toHaveBeenCalledExactlyOnceWith(
      "sk-inline",
      expect.any(AbortSignal),
    );
    expect(deps.appendEnv).toHaveBeenCalledExactlyOnceWith(
      `${APP_ROOT}/.env.local`,
      { AI_GATEWAY_API_KEY: "sk-inline" },
      { force: true },
    );
  });

  it("returns the committed key when interruption races the env write", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async () => ({
      kind: "ai-gateway-key",
      key: "sk-committed",
      validation: { kind: "valid" },
    });
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    deps.appendEnv.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await releaseWrite.promise;
      return { written: ["AI_GATEWAY_API_KEY"], skipped: [] };
    });
    const controller = new AbortController();

    const execution = runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      signal: controller.signal,
      deps,
    });
    await writeStarted.promise;
    controller.abort();
    releaseWrite.resolve();

    await expect(execution).resolves.toEqual({ kind: "ai-gateway-key" });
  });

  it("shows direct-provider instructions without changing credentials", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    const result = await runTestProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async () => ({ kind: "external" }),
      deps,
    });

    expect(result).toEqual({ kind: "external-provider" });
    expect(fake.prompter.acknowledge).toHaveBeenCalledExactlyOnceWith({
      message: EXTERNAL_PROVIDER_INSTRUCTIONS_TITLE,
      lines: EXTERNAL_PROVIDER_INSTRUCTIONS,
    });
    expect(deps.appendEnv).not.toHaveBeenCalled();
  });

  it("folds a cancelled provider picker into the flow's cancelled result", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    await expect(
      runTestProviderFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        picker: async () => undefined,
        deps,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });
});
