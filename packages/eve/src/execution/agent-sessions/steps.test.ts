import { beforeEach, describe, expect, it, vi } from "vitest";

import { NonRetryableError } from "#shared/run-errors.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { agent } from "#public/tools/agent.js";
import {
  openAgentSessionStep,
  sendAgentSessionMessageStep,
  stopLateAgentSessionStep,
} from "#execution/agent-sessions/steps.js";

const mocks = vi.hoisted(() => ({
  bundle: { graph: {} } as Record<string, unknown>,
  createSession: vi.fn(),
  dispatch: vi.fn(),
  resolveSessionInbox: vi.fn(),
  resumeSessionStartHook: vi.fn(),
  resumeHook: vi.fn(),
  startWorkflow: vi.fn(),
  logError: vi.fn(),
  runtimeConfig: undefined as unknown,
  targetKind: "local" as "local" | "remote",
}));

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ stepId: "step_0" }),
  getWorkflowMetadata: () => ({ workflowRunId: "run_0" }),
}));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/workflow-runtime.js")>()),
  createWorkflowRuntime: (config: unknown) => {
    mocks.runtimeConfig = config;
    return { createSession: mocks.createSession };
  },
  dispatchWorkflowSessionCommand: mocks.dispatch,
  startWorkflowOnCurrentDeployment: mocks.startWorkflow,
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  resumeHook: mocks.resumeHook,
}));
vi.mock("#internal/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/logging.js")>()),
  logError: mocks.logError,
}));
vi.mock("#execution/session-inbox/resume.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/session-inbox/resume.js")>()),
  resolveSessionInbox: mocks.resolveSessionInbox,
  resumeSessionStartHook: mocks.resumeSessionStartHook,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async () => mocks.bundle,
}));
vi.mock("#runtime/durable-compiled-artifacts-source.js", () => ({
  resolveDurableCompiledArtifactsSource: (source: unknown) => source,
}));
vi.mock("#execution/agent-sessions/target.js", () => {
  const action = { callId: "call-1", name: "reviewer", nodeId: "reviewer" };
  return {
    resolveAgentAction: () => action,
    resolveAgentStartTarget: () =>
      mocks.targetKind === "remote"
        ? { action, kind: "remote" }
        : { action, kind: "local", source: { type: "declared" } },
  };
});
vi.mock("#subagents/tool.js", () => ({
  buildSubagentRunInput: (input: { readonly continuationKey: string }) => ({
    childContinuationToken: `subagent:${input.continuationKey}`,
    runInput: {},
  }),
}));

const context = {
  bundle: { source: {} },
  dynamicSelections: {},
  parent: { callId: "call-1", rootSessionId: "parent-1", sessionId: "parent-1" },
  sandbox: {},
  trace: {},
} as AgentSessionContext;

const session = {
  address: {
    continuationToken: "child-continuation",
    kind: "local",
    name: "reviewer",
    nodeId: "reviewer",
    sessionId: "child-1",
  },
  context,
  key: "run-1:0",
} as const;

const message = {
  ...session,
  auth: { current: null, initiator: null },
  message: "Bob asks for a second look at the plan.",
  replyTo: "reply-1",
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.bundle = { graph: {} };
  mocks.runtimeConfig = undefined;
  mocks.targetKind = "local";
});

describe("openAgentSessionStep", () => {
  const open = () => openAgentSessionStep({ ...message, name: "reviewer" });

  it("returns the session it started without waiting for the session to boot", async () => {
    mocks.createSession.mockResolvedValue({ sessionId: "child-1" });

    await expect(open()).resolves.toEqual({
      address: {
        continuationToken: "subagent:run-1:0",
        kind: "local",
        name: "reviewer",
        nodeId: "reviewer",
        sessionId: "child-1",
      },
      deliveryId: "agent-session:run-1:0:initial",
    });
  });

  it("binds a model override to the local child runtime", async () => {
    mocks.createSession.mockResolvedValue({ sessionId: "child-1" });

    await openAgentSessionStep({
      ...message,
      model: {
        model: "anthropic/claude-opus-5.5",
        modelContextWindowTokens: 200_000,
        reasoning: "high",
      },
      name: "reviewer",
    });

    expect(mocks.runtimeConfig).toMatchObject({
      agentSessionRuntimeOverrides: {
        model: {
          contextWindowTokens: 200_000,
          id: "anthropic/claude-opus-5.5",
          reasoning: "high",
        },
      },
    });
  });

  it("rejects a model override for a remote target without retrying", async () => {
    mocks.targetKind = "remote";

    await expect(
      openAgentSessionStep({
        ...message,
        model: "anthropic/claude-opus-5.5",
        name: "reviewer",
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid model selection without retrying", async () => {
    await expect(
      openAgentSessionStep({
        ...message,
        model: "",
        name: "reviewer",
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe("openAgentSessionStep with an agent({ models }) option", () => {
  const haiku = {
    doGenerate: async () => ({}),
    doStream: async () => ({}),
    modelId: "claude-haiku-5",
    provider: "anthropic.messages",
    specificationVersion: "v3",
  } as const;
  const tool = agent({
    models: {
      haiku: {
        description: "Cheap lookups",
        model: haiku,
        modelContextWindowTokens: 200_000,
        reasoning: "low",
      },
      luna: {
        description: "Routine tasks",
        model: "openai/gpt-6-luna",
        modelContextWindowTokens: 400_000,
      },
    },
  });
  const toolSource = {
    logicalPath: "tools/agent.ts",
    sourceId: "tools-agent",
    sourceKind: "module",
  };

  beforeEach(() => {
    mocks.bundle = {
      graph: {},
      modelMetadata: async () => ({ fetchedAt: null, models: [] }),
      moduleMap: {
        nodes: {
          __root__: {
            modules: { "tools-agent": { default: tool }, "tools-reviewer": { default: {} } },
          },
        },
      },
      resolvedAgent: {
        tools: [
          {
            ...toolSource,
            behavior: { handling: { kind: "workflow-tool" } },
            name: "agent",
          },
          {
            behavior: { handling: { kind: "workflow-tool" } },
            logicalPath: "tools/invoke-reviewer.ts",
            name: "invoke-reviewer",
            sourceId: "tools-reviewer",
            sourceKind: "module",
          },
        ],
      },
    };
    mocks.createSession.mockResolvedValue({ sessionId: "child-1" });
  });

  const open = (key: string) =>
    openAgentSessionStep({ ...message, model: key, name: "agent", toolName: "agent" });

  it("binds a Gateway option inline", async () => {
    await open("luna");

    expect(mocks.runtimeConfig).toMatchObject({
      agentSessionRuntimeOverrides: {
        model: { contextWindowTokens: 400_000, id: "openai/gpt-6-luna" },
      },
    });
    expect(mocks.runtimeConfig).not.toHaveProperty("agentSessionRuntimeOverrides.model.source");
  });

  it("binds a live model option as a reference to the tool and key", async () => {
    await open("haiku");

    expect(mocks.runtimeConfig).toEqual(
      expect.objectContaining({
        agentSessionRuntimeOverrides: {
          model: expect.objectContaining({
            contextWindowTokens: 200_000,
            reasoning: "low",
            source: toolSource,
            sourceModelOption: "haiku",
          }),
        },
      }),
    );
    expect(JSON.parse(JSON.stringify(mocks.runtimeConfig))).toMatchObject({
      agentSessionRuntimeOverrides: { model: { sourceModelOption: "haiku" } },
    });
  });

  it("rejects a model the tool doesn't list, even a Gateway ID, without retrying", async () => {
    await expect(open("openai/gpt-6-sol")).rejects.toBeInstanceOf(NonRetryableError);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("resolves a model from any other workflow tool's run as a model selection", async () => {
    await openAgentSessionStep({
      ...message,
      model: { model: "openai/gpt-6-sol", modelContextWindowTokens: 400_000 },
      name: "agent",
      toolName: "invoke-reviewer",
    });

    expect(mocks.runtimeConfig).toMatchObject({
      agentSessionRuntimeOverrides: { model: { id: "openai/gpt-6-sol" } },
    });
  });
});

describe("commands to a session that opened without waiting", () => {
  it("delivers to the session a duplicate start claimed when the recorded run lost it", async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: "session_not_active" }).mockResolvedValueOnce({
      sessionId: "child-2",
      status: "accepted",
    });
    mocks.resolveSessionInbox.mockResolvedValue({ sessionId: "child-2" });

    await sendAgentSessionMessageStep(message);

    expect(mocks.resolveSessionInbox).toHaveBeenCalledWith("child-continuation");
    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "child-2" }),
    );
  });

  it("logs an unavailable late child without scheduling another workflow", async () => {
    const unavailable = new HookNotFoundError("child-inbox");
    mocks.resumeHook.mockRejectedValue(unavailable);

    await expect(stopLateAgentSessionStep(session)).resolves.toBeUndefined();

    expect(mocks.resumeHook).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "reset" }),
    );
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("late child"),
      unavailable,
      { sessionId: "child-1" },
    );
  });

  it("fails a message to a session that ended", async () => {
    mocks.dispatch.mockResolvedValue({ status: "session_not_active" });
    mocks.resolveSessionInbox.mockRejectedValue(new HookNotFoundError("child-continuation"));

    await expect(sendAgentSessionMessageStep(message)).rejects.toThrow(
      'Agent "reviewer" can no longer receive messages; its session ended.',
    );
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
});
