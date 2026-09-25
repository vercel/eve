import { describe, expect, it, vi } from "vitest";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import type { AgentTUIRenderer, PromptCommandHandlerContext } from "./runner.js";
import type { SetupFlowRenderer } from "./setup-flow.js";

vi.mock("#setup/flows/model.js", () => ({
  modelChangeRefusalForUneditableModel: vi.fn(),
}));
vi.mock("#compiler/model-catalog.js", () => ({
  createCompiledRuntimeModelCatalogLoader: vi.fn(),
}));
vi.mock("#discover/discover-agent.js", () => ({
  discoverAgent: vi.fn(),
}));
vi.mock("#source-change/static-source-change.js", () => ({
  createStaticSourceChange: vi.fn(),
}));

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
const WORKSPACE_AGENT_ROOT = "/tmp/weather-workspace/agents/support";
const WORKSPACE_TARGET = {
  kind: "local",
  serverUrl: "http://localhost:3000",
  workspaceRoot: "/tmp/weather-workspace",
  agentRoot: WORKSPACE_AGENT_ROOT,
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
    withInheritedStdio: (task) => task(),
    waitForInterrupt: () => ({
      promise: new Promise<"escape" | "ctrl-c">(() => {}),
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
      message: "",
      summary: "Model set to anthropic/claude-opus-4.6",
    });
    expect(applyModel).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      slug: "anthropic/claude-opus-4.6",
    });
  });

  it("marks an unchanged model as neutral", async () => {
    const handler = createPromptCommandHandler({
      target: LOCAL_TARGET,
      applyModel: async ({ slug }) => ({ kind: "unchanged", model: slug }),
      modelChangeRefusal: async () => null,
    });

    await expect(
      handler.handle({ type: "extension", name: "model", argument: "openai/gpt-5.5" }, context()),
    ).resolves.toEqual({
      message: "",
      summary: "Model already set to openai/gpt-5.5",
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
      summary: "Couldn't change the model",
      failed: true,
    });
    expect(applyModel).not.toHaveBeenCalled();
  });

  it("requires the inline drawer to complete a bare /model", async () => {
    const applyModel = vi.fn(async () => ({ kind: "rejected", message: "unused" }) as const);
    const readInputQuestion = vi.fn(async () => ({ optionId: "openai/gpt-5" }));
    const handler = createPromptCommandHandler({
      target: LOCAL_TARGET,
      applyModel,
    });

    await expect(
      handler.handle(
        { type: "extension", name: "model", argument: "" },
        context({ readInputQuestion }),
      ),
    ).resolves.toEqual({ message: "Choose a model from the inline /model suggestions." });
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

  it("routes a /login argument to its connection", async () => {
    const runTuiSetupCommand = vi.fn(async () => ({
      message: "Connected.",
      preserveFlowDiagnostics: false,
    }));
    vi.doMock("./setup-commands.js", () => ({
      SETUP_FLOW_CONFIG: { login: { title: "", indicator: "pulse" } },
      runTuiSetupCommand,
    }));

    try {
      const handler = createPromptCommandHandler({ target: LOCAL_TARGET });
      await handler.handle(
        { type: "extension", name: "login", argument: "openai-api-key" },
        context({ setupFlow: setupFlowRenderer() }),
      );
      expect(runTuiSetupCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: "login", initialLoginConnection: "openai" }),
      );
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });

  it("rejects an unknown /login connection", async () => {
    const handler = createPromptCommandHandler({ target: LOCAL_TARGET });

    await expect(
      handler.handle(
        { type: "extension", name: "login", argument: "other" },
        context({ setupFlow: setupFlowRenderer() }),
      ),
    ).resolves.toEqual({
      message: "Use `/login vercel|chatgpt|vercel-api-key|openai-api-key|anthropic-api-key`.",
    });
  });

  it("routes a /add argument to the registry flow's initial address", async () => {
    const runTuiSetupCommand = vi.fn(async () => ({
      message: "Added Slack",
      preserveFlowDiagnostics: true,
    }));
    vi.doMock("./setup-commands.js", () => ({
      SETUP_FLOW_CONFIG: { add: { title: "Add to your agent", indicator: "pulse" } },
      runTuiSetupCommand,
    }));

    try {
      const setupFlow = setupFlowRenderer();
      const handler = createPromptCommandHandler({ target: LOCAL_TARGET });

      await handler.handle(
        { type: "extension", name: "add", argument: "channel/slack" },
        context({ setupFlow }),
      );
      expect(runTuiSetupCommand).toHaveBeenCalledOnce();
      expect(runTuiSetupCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: "add", initialRegistryAddress: "channel/slack" }),
      );
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });

  it("installs /add items into the selected workspace agent", async () => {
    const runTuiSetupCommand = vi.fn(async () => ({
      message: "Added Slack",
      preserveFlowDiagnostics: true,
    }));
    vi.doMock("./setup-commands.js", () => ({
      SETUP_FLOW_CONFIG: { add: { title: "Add to your agent", indicator: "pulse" } },
      runTuiSetupCommand,
    }));

    try {
      const handler = createPromptCommandHandler({ target: WORKSPACE_TARGET });
      await handler.handle(
        { type: "extension", name: "add", argument: "channel/slack" },
        context({ setupFlow: setupFlowRenderer() }),
      );

      expect(runTuiSetupCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          agentRoot: WORKSPACE_AGENT_ROOT,
          appRoot: WORKSPACE_TARGET.workspaceRoot,
          command: "add",
        }),
      );
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });

  it.each([false, true])("holds login open through runtime refresh (failure: %s)", async (fail) => {
    vi.doMock("./setup-commands.js", () => ({
      SETUP_FLOW_CONFIG: { login: { title: "Connect a model", indicator: "pulse" } },
      runTuiSetupCommand: async () => ({
        message: "Connected.",
        effect: { kind: "model-access-changed", reload: true },
        preserveFlowDiagnostics: false,
      }),
    }));
    try {
      const setupFlow = setupFlowRenderer();
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settleOutcome = vi.fn(async () => {
        await pending;
        return fail
          ? { failed: true as const, message: "The agent could not reload." }
          : { message: "Connected." };
      });
      const handler = createPromptCommandHandler({ target: LOCAL_TARGET });
      const result = handler.handle(
        { type: "extension", name: "login", argument: "" },
        { ...context({ setupFlow }), settleOutcome },
      );
      await vi.waitFor(() => expect(settleOutcome).toHaveBeenCalledOnce());
      expect(setupFlow.end).not.toHaveBeenCalled();
      release();
      const outcome = await result;
      if (outcome === undefined) throw new Error("Expected a login outcome");
      expect(setupFlow.end).toHaveBeenCalledOnce();
      expect(outcome.effect).toBeUndefined();
      if (fail) {
        expect(outcome.failed).toBe(true);
        expect(outcome.message).toContain("could not reload");
        expect(outcome.message).not.toContain("private runtime failure");
      } else {
        expect(outcome.message).toBe("Connected.");
      }
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
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
        handler.handle(
          { type: "extension", name: "add", argument: "channel/slack" },
          context({ setupFlow }),
        ),
      ).resolves.toEqual({
        message: expect.stringMatching(/^\/add failed: /),
      });
      expect(setupFlow.begin).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("./setup-commands.js");
      vi.resetModules();
    }
  });
});
