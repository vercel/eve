import pc from "picocolors";
import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { VercelAuthStatus } from "#setup/vercel-project.js";

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
      resolution: { credential: "oidc", file: ".env.local" },
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

describe("runProviderFlow", () => {
  it("hands the Dev TUI one provider menu", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.message).toBe(PROVIDER_QUESTION);
      expect(request.options.map((option) => option.value)).toEqual([
        "project",
        "own-key",
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
      expect(request.initialValue).toBe("project");
      return { kind: "project" };
    };

    const result = await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      deps,
    });

    expect(result).toEqual({
      kind: "project",
      result: {
        kind: "done",
        resolution: { credential: "oidc", file: ".env.local" },
      },
    });
    expect(deps.runLinkFlow).toHaveBeenCalledExactlyOnceWith({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      projectSelection: "create-or-link",
    });
  });

  it("returns ChatGPT without touching Gateway setup", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    const result = await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async (request) => {
        expect(request.options.map((option) => option.value)).toEqual([
          "project",
          "own-key",
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

  it("checks and describes the active provider, opening the cursor on it", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const linked: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("project");
      expect(request.options[0]).toMatchObject({
        value: "project",
        checked: true,
        hint: `Linked to ${pc.bold("my-agent")} in team ${pc.bold("my-team")}`,
      });
      expect(request.options[1]?.checked).toBeUndefined();
      return undefined;
    };
    await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: linked,
      providerState: {
        available: { gatewayProject: { projectName: "my-agent", teamName: "my-team" } },
        preferredGatewayCredential: "project",
      },
      deps,
    });

    const keyed: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("own-key");
      expect(request.options[1]).toMatchObject({
        value: "own-key",
        checked: true,
        hint: "AI_GATEWAY_API_KEY set in .env.local",
      });
      return undefined;
    };
    await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: keyed,
      providerState: {
        available: { gatewayKey: { source: { kind: "env-file", path: ".env.local" } } },
        preferredGatewayCredential: "api-key",
      },
      deps,
    });
  });

  it("uses the persisted Gateway preference when credentials compete", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();
    const picker: ProviderPicker = async (request) => {
      expect(request.initialValue).toBe("project");
      expect(request.options.find((option) => option.value === "project")?.checked).toBe(true);
      expect(request.options.find((option) => option.value === "own-key")?.checked).toBeUndefined();
      return undefined;
    };

    await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      providerState: {
        available: {
          gatewayProject: { projectName: "my-agent" },
          gatewayKey: { source: { kind: "shell" } },
        },
        preferredGatewayCredential: "project",
      },
      deps,
    });
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

    await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      providerState: {
        available: { gatewayProject: { projectName: "my-agent" } },
        preferredGatewayCredential: "project",
      },
      selectedProvider: "chatgpt",
      deps,
    });
  });

  it("reports a committed key as one set line", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker: async () => ({ kind: "inline-key", key: "sk-inline", validation: { kind: "valid" } }),
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
      return { kind: "inline-key", key: "sk-inline", validation };
    };

    const result = await runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      deps,
    });

    expect(result).toEqual({
      kind: "done",
      resolution: { credential: "api-key", source: { kind: "env-file", path: ".env.local" } },
    });
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
      kind: "inline-key",
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

    const execution = runProviderFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      picker,
      signal: controller.signal,
      deps,
    });
    await writeStarted.promise;
    controller.abort();
    releaseWrite.resolve();

    await expect(execution).resolves.toEqual({
      kind: "done",
      resolution: { credential: "api-key", source: { kind: "env-file", path: ".env.local" } },
    });
  });

  it("shows direct-provider instructions without changing credentials", async () => {
    const fake = createFakePrompter();
    const deps = createDeps();

    const result = await runProviderFlow({
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
      runProviderFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        picker: async () => undefined,
        deps,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(deps.runLinkFlow).not.toHaveBeenCalled();
  });
});
