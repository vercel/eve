import { describe, expect, it, vi } from "vitest";
import { startLocalSubagent } from "#subagents/start-local.js";
import { createWorkflowRuntime, waitForCommandHookOwner } from "#execution/workflow-runtime.js";
import { resolveRuntimeModelSelection } from "#runtime/agent/resolve-model.js";
import type { RunInput } from "#channel/types.js";

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: vi.fn(),
  waitForCommandHookOwner: vi.fn(),
}));
vi.mock("#runtime/agent/resolve-model.js", () => ({
  resolveRuntimeModelSelection: vi.fn(),
}));

describe("local delegation execution", () => {
  it("returns a recoverable dispatch error when model resolution fails", async () => {
    vi.mocked(resolveRuntimeModelSelection).mockRejectedValue(
      new Error("Model catalog unavailable"),
    );
    const session = { sessionId: "parent" };
    const result = await startLocalSubagent({
      action: {
        callId: "call",
        name: "worker",
        subagentName: "worker",
        nodeId: "worker",
        kind: "subagent-call",
        description: "Work",
        input: { message: "Review", execution: { model: "openai/gpt-5.5" } },
      },
      bundle: {
        graph: {
          nodesByNodeId: new Map([
            [
              "worker",
              {
                agent: { config: { delegationModels: ["openai/gpt-5.5"] } },
              },
            ],
          ]),
        },
      },
      currentSession: session,
      source: { type: "local" },
    } as never);
    expect(result).toMatchObject({
      kind: "error",
      session,
      result: { isError: true, output: { message: "Model catalog unavailable" } },
    });
  });
  it("starts separate children with selected models while retaining authored limits and shared sandbox", async () => {
    const createSession = vi
      .fn<(input: RunInput) => Promise<{ runId: string }>>()
      .mockResolvedValue({ runId: "child" });
    vi.mocked(createWorkflowRuntime).mockReturnValue({ createSession } as never);
    vi.mocked(waitForCommandHookOwner).mockResolvedValue({ runId: "child" } as never);
    vi.mocked(resolveRuntimeModelSelection).mockImplementation(async ({ selection }) => ({
      reference: {
        id:
          typeof selection === "string"
            ? selection
            : "model" in selection
              ? String(selection.model)
              : selection.modelId,
      },
    }));
    const session = {
      agent: { modelReference: { id: "parent" }, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10000 },
      continuationToken: "parent-token",
      history: [],
      limits: { maxTokenCostUsdPerSession: 4 },
      sessionId: "parent",
      sandboxState: { sandboxId: "shared" },
    };
    for (const [index, model] of ["openai/gpt-5.5", "google/gemini-2.5-flash"].entries()) {
      await startLocalSubagent({
        action: {
          callId: `call-${index}`,
          name: "worker",
          subagentName: "worker",
          nodeId: "worker",
          kind: "subagent-call",
          description: "Work",
          input: {
            message: "Read the assignment",
            execution: { model, reasoning: "low", maxCostUsd: 0.25 },
          },
        },
        auth: null,
        initiatorAuth: null,
        batchEvent: { sequence: 0, turnId: "turn" },
        bundle: {
          compiledArtifactsSource: {},
          graph: {
            nodesByNodeId: new Map([
              [
                "worker",
                {
                  agent: {
                    config: {
                      model: { id: "default" },
                      description: "Work",
                      delegationModels: ["openai/gpt-5.5", "google/gemini-2.5-flash"],
                      limits: { maxTokenCostUsdPerSession: 2, maxOutputTokensPerSession: 1000 },
                    },
                  },
                  sandboxRegistry: { sandbox: { definition: { inheritsParent: true } } },
                },
              ],
            ]),
          },
        },
        currentSession: session,
        session,
        fanoutSize: 2,
        sandboxSessionId: "parent",
        source: { type: "local", description: "Work" },
      } as never);
      expect(vi.mocked(createWorkflowRuntime).mock.calls[index]?.[0]).toMatchObject({
        nodeId: "worker",
        dynamicSubagentAgentConfig: {
          model: { id: model },
          reasoning: "low",
          limits: { maxTokenCostUsdPerSession: 2, maxOutputTokensPerSession: 1000 },
        },
      });
      expect(createSession.mock.calls[index]?.[0]).toMatchObject({
        limits: { maxTokenCostUsdPerSession: 0.25 },
        adapter: {
          state: { sandboxSessionId: "parent", parentSandboxState: { sandboxId: "shared" } },
        },
      });
    }
  });
});
