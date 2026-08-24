import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadHarnessAdapter } from "#execution/harness-agent/adapter.js";

const mocks = vi.hoisted(() => ({
  createClaudeCode: vi.fn(),
  createCline: vi.fn(),
  createCodex: vi.fn(),
  createDeepAgents: vi.fn(),
  createGrokBuild: vi.fn(),
  createOpenCode: vi.fn(),
  createPi: vi.fn(),
}));

vi.mock("#compiled/@ai-sdk/harness-claude-code/index.js", () => ({
  createClaudeCode: mocks.createClaudeCode,
}));
vi.mock("#compiled/@ai-sdk/harness-cline/index.js", () => ({ createCline: mocks.createCline }));
vi.mock("#compiled/@ai-sdk/harness-codex/index.js", () => ({ createCodex: mocks.createCodex }));
vi.mock("#compiled/@ai-sdk/harness-deepagents/index.js", () => ({
  createDeepAgents: mocks.createDeepAgents,
}));
vi.mock("#compiled/@ai-sdk/harness-grok-build/index.js", () => ({
  createGrokBuild: mocks.createGrokBuild,
}));
vi.mock("#compiled/@ai-sdk/harness-opencode/index.js", () => ({
  createOpenCode: mocks.createOpenCode,
}));
vi.mock("#compiled/@ai-sdk/harness-pi/index.js", () => ({ createPi: mocks.createPi }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset().mockReturnValue({});
  }
});

describe("loadHarnessAdapter", () => {
  it("passes the selected port and WebSocket endpoint to a bridge adapter", async () => {
    const bridge = {
      port: 4319,
      portEndpoint: { url: "wss://sandbox.example.test/" },
    };

    await loadHarnessAdapter({ bridge, harness: "codex", model: "gpt-codex" });

    expect(mocks.createCodex).toHaveBeenCalledWith({
      model: "gpt-codex",
      port: 4319,
      portEndpoint: { url: "wss://sandbox.example.test/" },
    });
  });

  it("does not pass bridge settings to an in-process adapter", async () => {
    await loadHarnessAdapter({ harness: "cline", model: "cline-model" });

    expect(mocks.createCline).toHaveBeenCalledWith({ modelId: "cline-model" });
  });
});
