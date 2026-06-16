import pc from "picocolors";
import { describe, expect, it, vi } from "vitest";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import type { AgentTUIRenderer, PromptCommandHandlerContext } from "./runner.js";
import type { SetupFlowRenderer } from "./setup-flow.js";

const APP_ROOT = "/tmp/weather-agent";

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
      appRoot: APP_ROOT,
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
      appRoot: APP_ROOT,
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
    const handler = createPromptCommandHandler({ appRoot: APP_ROOT, applyModel });

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
    const handler = createPromptCommandHandler({});

    await expect(
      handler.handle({ type: "extension", name: "model", argument: "" }, context()),
    ).resolves.toEqual({
      message: "/model needs eve dev running the local server (it is not available with --url).",
    });
  });

  it("folds setup-module load failures at the command adapter boundary", async () => {
    vi.doMock("./setup-commands.js", () => {
      throw new Error("Cannot find package 'oxc-parser'");
    });

    try {
      const setupFlow = setupFlowRenderer();
      const handler = createPromptCommandHandler({ appRoot: APP_ROOT });

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
