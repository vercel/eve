import pc from "picocolors";
import { describe, expect, it, vi } from "vitest";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import type { RemoteAuthCompletion, RemoteConnectionController } from "./remote-connection.js";
import type { AgentTUIRenderer, PromptCommandHandlerContext } from "./runner.js";
import type { SetupFlowRenderer } from "./setup-flow.js";

const APP_ROOT = "/tmp/weather-agent";
const LOCAL_TARGET = {
  kind: "local",
  serverUrl: "http://localhost:3000",
  workspaceRoot: APP_ROOT,
} as const;
const REMOTE_TARGET = {
  kind: "remote",
  serverUrl: "https://example.com/",
  workspaceRoot: APP_ROOT,
} as const;

function context(renderer: Partial<AgentTUIRenderer> = {}): PromptCommandHandlerContext {
  return {
    renderer: {
      renderStream: vi.fn(async () => {}),
      ...renderer,
    },
    title: "Weather Agent",
  };
}

function setupFlowRenderer() {
  return {
    begin: vi.fn(),
    end: vi.fn(),
    readSelect: vi.fn(async () => undefined),
    readEditableSelect: vi.fn(async () => undefined),
    readProviderPicker: vi.fn(async () => undefined),
    readText: vi.fn(async () => undefined),
    readAcknowledge: vi.fn(async () => {}),
    readChoice: vi.fn(() => ({ choice: Promise.resolve(undefined), close: vi.fn() })),
    setStatus: vi.fn(),
    renderLine: vi.fn(),
    renderOutput: vi.fn(),
    waitForInterrupt: () => ({
      promise: new Promise<void>(() => {}),
      dispose: vi.fn(),
    }),
  } satisfies SetupFlowRenderer;
}

describe("createPromptCommandHandler", () => {
  it("applies an explicit model slug without opening the picker", async () => {
    const applyModel = vi.fn(
      async ({ slug }: { appRoot: string; slug: string }) =>
        ({ kind: "changed", to: slug }) as const,
    );
    const handler = createPromptCommandHandler({
      target: LOCAL_TARGET,
      applyModel,
      modelChangeRefusal: async () => null,
    });

    await expect(
      handler.handle(
        { type: "extension", name: "model", argument: "anthropic/claude-opus-4.6" },
        context(),
      ),
    ).resolves.toEqual({
      message: `Model changed to ${pc.bold("anthropic/claude-opus-4.6")}. Live on your next prompt.`,
    });
    expect(applyModel).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      slug: "anthropic/claude-opus-4.6",
    });
  });

  it("refuses an explicit model slug when the model is an external provider", async () => {
    const applyModel = vi.fn(
      async ({ slug }: { appRoot: string; slug: string }) =>
        ({ kind: "changed", to: slug }) as const,
    );
    const handler = createPromptCommandHandler({
      target: LOCAL_TARGET,
      applyModel,
      modelChangeRefusal: async () => "Model is pinned to the external provider `anthropic`.",
    });

    await expect(
      handler.handle({ type: "extension", name: "model", argument: "openai/gpt-5.4" }, context()),
    ).resolves.toEqual({
      message: "Model is pinned to the external provider `anthropic`.",
    });
    expect(applyModel).not.toHaveBeenCalled();
  });

  it("sends a bare /model down the setup-flow path, not a bespoke picker", async () => {
    const applyModel = vi.fn(async () => ({ kind: "rejected", message: "unused" }) as const);
    const readInputQuestion = vi.fn(async () => ({ optionId: "openai/gpt-5" }));
    const handler = createPromptCommandHandler({
      target: LOCAL_TARGET,
      applyModel,
    });

    // No setupFlow on the renderer: the flow path reports itself instead of
    // falling back to the old readInputQuestion picker.
    await expect(
      handler.handle(
        { type: "extension", name: "model", argument: "" },
        context({ readInputQuestion }),
      ),
    ).resolves.toEqual({ message: "/model is not supported by this renderer." });
    expect(readInputQuestion).not.toHaveBeenCalled();
    expect(applyModel).not.toHaveBeenCalled();
  });

  it("reports that model changes need the local dev server", async () => {
    const handler = createPromptCommandHandler({
      target: REMOTE_TARGET,
    });

    await expect(
      handler.handle({ type: "extension", name: "model", argument: "" }, context()),
    ).resolves.toEqual({
      message: "/model needs eve dev running the local server (it is not available with --url).",
    });
  });

  it("forwards automatic provider entry and model-access changes", async () => {
    const runTuiSetupCommand = vi.fn(async () => ({
      message: "Connected to AI Gateway via AI_GATEWAY_API_KEY in .env.local.",
      preserveFlowDiagnostics: false,
      effect: { kind: "model-access-changed" } as const,
    }));
    vi.doMock("./setup-commands.js", () => ({
      SETUP_FLOW_CONFIG: {
        model: { title: "Configure the agent model", indicator: "pulse" },
      },
      runTuiSetupCommand,
    }));

    try {
      const setupFlow = setupFlowRenderer();
      const handler = createPromptCommandHandler({ target: LOCAL_TARGET });

      await expect(
        handler.handle(
          { type: "extension", name: "model", argument: "" },
          { ...context({ setupFlow }), initialModelStep: "provider" },
        ),
      ).resolves.toEqual({
        message: "Connected to AI Gateway via AI_GATEWAY_API_KEY in .env.local.",
        effect: { kind: "model-access-changed" },
      });
      expect(runTuiSetupCommand).toHaveBeenCalledWith(
        expect.objectContaining({ initialModelStep: "provider" }),
      );
      expect(setupFlow.begin).toHaveBeenCalledWith("Configure the agent model", "pulse");
      expect(setupFlow.end).toHaveBeenCalledWith({ preserveDiagnostics: false });
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });

  it("reports a login that completed before remote authentication was cancelled", async () => {
    const setupFlow = setupFlowRenderer();
    const runLoginFlow = vi.fn(async () => ({ kind: "cancelled" as const }));
    const remoteConnection: RemoteConnectionController = {
      current: () => ({
        target: REMOTE_TARGET,
        connection: {
          state: "auth-required",
          challenge: { kind: "eve-oidc" },
        },
      }),
      check: async () => ({
        state: "auth-required",
        challenge: { kind: "eve-oidc" },
      }),
      authenticate: async () => ({
        kind: "cancelled",
        completedMutations: [{ kind: "vercel-login" }],
      }),
      reportFailure: () => ({ state: "checking" }),
      dispose() {},
    };
    const handler = createPromptCommandHandler({
      target: REMOTE_TARGET,
      flows: { runLoginFlow },
    });

    await expect(
      handler.handle(
        { type: "extension", name: "vc:login", argument: "" },
        {
          ...context({ setupFlow }),
          remoteConnection,
        },
      ),
    ).resolves.toEqual({
      message: "/vc:login cancelled after logging in to Vercel.",
    });
    expect(runLoginFlow).not.toHaveBeenCalled();
    expect(setupFlow.begin).toHaveBeenCalledWith("Authenticate via Vercel OIDC", "pulse");
    expect(setupFlow.end).toHaveBeenCalledWith({ preserveDiagnostics: true });
  });

  it("reports mutations that completed before remote /vc:login was interrupted", async () => {
    const setupFlow = {
      ...setupFlowRenderer(),
      waitForInterrupt: () => ({ promise: Promise.resolve(), dispose: vi.fn() }),
    } satisfies SetupFlowRenderer;
    const runLoginFlow = vi.fn(async () => ({ kind: "cancelled" as const }));
    const remoteConnection: RemoteConnectionController = {
      current: () => ({
        target: REMOTE_TARGET,
        connection: { state: "auth-required", challenge: { kind: "eve-oidc" } },
      }),
      check: async () => ({
        state: "auth-required",
        challenge: { kind: "eve-oidc" },
      }),
      authenticate: async (_attempt, signal) =>
        await new Promise<RemoteAuthCompletion>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve({
                kind: "cancelled" as const,
                completedMutations: [
                  { kind: "trusted-sources-updated", targetProjectName: "remote-agent" },
                ],
              }),
            { once: true },
          );
        }),
      reportFailure: () => ({ state: "checking" }),
      dispose() {},
    };
    const handler = createPromptCommandHandler({
      target: REMOTE_TARGET,
      flows: { runLoginFlow },
    });

    await expect(
      handler.handle(
        { type: "extension", name: "vc:login", argument: "" },
        { ...context({ setupFlow }), remoteConnection },
      ),
    ).resolves.toEqual({
      message:
        "/vc:login interrupted. Completed before interruption: updated Trusted Sources for remote-agent.",
    });
    expect(runLoginFlow).not.toHaveBeenCalled();
  });

  it("folds setup-module load failures at the command adapter boundary", async () => {
    vi.doMock("./setup-commands.js", () => {
      throw new Error("Cannot find package 'oxc-parser'");
    });

    try {
      const setupFlow = setupFlowRenderer();
      const handler = createPromptCommandHandler({
        target: LOCAL_TARGET,
      });

      await expect(
        handler.handle({ type: "extension", name: "model", argument: "" }, context({ setupFlow })),
      ).resolves.toEqual({
        message: expect.stringMatching(/^\/model failed: /),
      });
      expect(setupFlow.begin).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });
});
