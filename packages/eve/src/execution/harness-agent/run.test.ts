import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHarnessAgent } from "#execution/harness-agent/run.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const mocks = vi.hoisted(() => ({
  agentSettings: undefined as unknown,
  createHarnessSandboxHandle: vi.fn(),
  createSession: vi.fn(),
  destroy: vi.fn(),
  dispose: vi.fn(),
  generate: vi.fn(),
  loadHarnessAdapter: vi.fn(),
  outputObject: vi.fn(),
}));

vi.mock("ai", () => ({ Output: { object: mocks.outputObject } }));
vi.mock("#compiled/@ai-sdk/harness/agent/index.js", () => ({
  HarnessAgent: class {
    constructor(settings: unknown) {
      mocks.agentSettings = settings;
    }

    createSession = mocks.createSession;
    generate = mocks.generate;
  },
}));
vi.mock("#execution/harness-agent/adapter.js", () => ({
  loadHarnessAdapter: mocks.loadHarnessAdapter,
}));
vi.mock("#execution/harness-agent/sandbox-session.js", () => ({
  createHarnessSandboxHandle: mocks.createHarnessSandboxHandle,
}));

const sandbox = { id: "eve-sandbox" } as SandboxSession;
const networkSession = { id: "harness-sandbox" };
const bridge = { port: 4319, portEndpoint: { url: "wss://sandbox.example.test/" } };
const adapter = { harnessId: "codex" };
const harnessSession = { destroy: mocks.destroy };

beforeEach(() => {
  mocks.agentSettings = undefined;
  mocks.createHarnessSandboxHandle.mockReset().mockResolvedValue({
    bridge,
    dispose: mocks.dispose,
    session: networkSession,
  });
  mocks.createSession.mockReset().mockResolvedValue(harnessSession);
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.generate.mockReset().mockResolvedValue({ output: undefined, text: "done" });
  mocks.loadHarnessAdapter.mockReset().mockResolvedValue(adapter);
  mocks.outputObject.mockReset();
});

describe("runHarnessAgent", () => {
  it("uses allow-all permissions and the caller-owned sandbox", async () => {
    const abortSignal = new AbortController().signal;
    const skills = [{ content: "Use rg.", description: "Search code", name: "search" }];

    await expect(
      runHarnessAgent({
        abortSignal,
        harness: "codex",
        model: "gpt-5.4-codex",
        sandbox,
        settings: {
          id: "implementation-agent",
          instructions: "Keep the change focused.",
          skills,
          workingDirectory: "packages/eve",
        },
        task: "Implement the change.",
      }),
    ).resolves.toBe("done");

    expect(mocks.createHarnessSandboxHandle).toHaveBeenCalledWith({
      harness: "codex",
      sandbox,
    });
    expect(mocks.loadHarnessAdapter).toHaveBeenCalledWith({
      bridge,
      harness: "codex",
      model: "gpt-5.4-codex",
    });
    expect(mocks.agentSettings).toMatchObject({
      harness: adapter,
      id: "implementation-agent",
      instructions: "Keep the change focused.",
      permissionMode: "allow-all",
      sandboxConfig: { workDir: "workspace/packages/eve" },
      skills,
    });
    expect(mocks.createSession).toHaveBeenCalledWith({
      abortSignal,
      sandboxSession: networkSession,
    });
    expect(mocks.generate).toHaveBeenCalledWith({
      abortSignal,
      prompt: "Implement the change.",
      session: harnessSession,
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("uses the tool output schema for HarnessAgent output and passes the result through", async () => {
    const outputSchema = z.object({ summary: z.string() });
    const outputDefinition = { type: "object-output" };
    const output = { summary: "Reviewed." };
    mocks.outputObject.mockReturnValue(outputDefinition);
    mocks.generate.mockResolvedValue({ output, text: "ignored" });

    await expect(
      runHarnessAgent({
        harness: "claude-code",
        outputSchema,
        sandbox,
        settings: {},
        task: "Review the change.",
      }),
    ).resolves.toEqual(output);

    expect(mocks.outputObject).toHaveBeenCalledWith({ schema: outputSchema });
    expect(mocks.agentSettings).toMatchObject({ output: outputDefinition });
  });

  it("does not replace an invocation failure with a cleanup failure", async () => {
    const invocationError = new Error("harness failed");
    mocks.generate.mockRejectedValue(invocationError);
    mocks.destroy.mockRejectedValue(new Error("destroy failed"));
    mocks.dispose.mockRejectedValue(new Error("dispose failed"));

    await expect(
      runHarnessAgent({
        harness: "pi",
        sandbox,
        settings: {},
        task: "Implement the change.",
      }),
    ).rejects.toBe(invocationError);
  });
});
