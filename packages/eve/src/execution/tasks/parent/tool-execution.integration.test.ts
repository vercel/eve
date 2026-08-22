import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ContinuationTokenKey,
  HandleEventKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import { runStep } from "#context/run-step.js";
import { createBackgroundSubagentHarnessDefinition } from "#execution/delegation-tool.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { backgroundToolExecutionProvider } from "#execution/tasks/parent/tool-execution.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { getRun } from "#internal/workflow/runtime.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
} from "#public/definitions/sandbox-backend.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { readSubagentTaskMetadata } from "#tasks/types.js";

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

describe("background subagent tool execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs concurrent local and remote defineTool calls as independent durable tasks", async () => {
    const runtime = await createTestRuntime({ agent: { name: "background-subagent" } });

    await runtime.run(async () => {
      const remoteNode = {
        description: "Remote reviewer",
        entryPath: "/virtual/eve-memory-app/agent/subagents/reviewer.ts",
        logicalPath: "subagents/reviewer.ts",
        name: "reviewer",
        nodeId: "remote/reviewer",
        path: "/eve/v1/session",
        rootPath: "/virtual/eve-memory-app/agent",
        sourceId: "subagents/reviewer.ts",
        sourceKind: "module",
        url: "https://remote.example.com",
      } as const;
      runtime.session.compiledArtifacts = {
        manifest: { ...runtime.manifest, remoteAgents: [remoteNode] },
        moduleMap: {
          nodes: {
            ...runtime.moduleMap.nodes,
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: {
                ...runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules,
                [remoteNode.sourceId]: { default: { url: remoteNode.url } },
              },
            },
          },
        },
      };
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const sandbox = mockSandbox({ id: "background-subagent-sandbox" });
      const backend: SandboxBackend = {
        create: async (input: SandboxBackendCreateInput) => ({
          captureState: async () => ({
            backendName: "test",
            metadata: {},
            sessionKey: input.sessionKey,
          }),
          session: sandbox.session,
          shutdown: async () => {},
          stop: async () => {},
          useSessionFn: async () => sandbox.session,
        }),
        name: "test",
        prewarm: async () => ({ reused: false }),
      };
      (
        bundle.graph.root.sandboxRegistry.sandbox.definition as {
          backend: SandboxBackend;
        }
      ).backend = backend;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ok: true, sessionId: "remote-child", status: "accepted" },
            { headers: { "x-eve-session-id": "remote-child" }, status: 202 },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const ctx = new ContextContainer();
      ctx.set(AuthKey, null);
      ctx.set(BundleKey, bundle);
      ctx.set(CallbackBaseUrlKey, "https://caller.example.com");
      ctx.set(ChannelKey, { kind: "http", state: {} });
      ctx.set(ContinuationTokenKey, "http:background-subagent");
      ctx.set(InitiatorAuthKey, null);
      ctx.set(SessionIdKey, "parent-background-subagent");

      const session: HarnessSession = setHarnessEmissionState(
        {
          agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:background-subagent",
          history: [],
          sessionId: "parent-background-subagent",
        },
        { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-background" },
      );
      const localTool = createBackgroundSubagentHarnessDefinition({
        description: "General-purpose agent",
        kind: "subagent",
        name: "agent",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      });
      const remoteTool = createBackgroundSubagentHarnessDefinition({
        description: remoteNode.description,
        kind: "remote",
        name: remoteNode.name,
        nodeId: remoteNode.nodeId,
      });
      const model = new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              input: JSON.stringify({ message: "Reply with exactly `background-child-a`." }),
              toolCallId: "call-background-child-a",
              toolName: "agent",
              type: "tool-call",
            },
            {
              input: JSON.stringify({ message: "Reply with exactly `background-child-b`." }),
              toolCallId: "call-background-child-b",
              toolName: "agent",
              type: "tool-call",
            },
            {
              input: JSON.stringify({ message: "Review the result." }),
              toolCallId: "call-background-remote",
              toolName: "reviewer",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      });

      let generated: Awaited<ReturnType<typeof generateText>> | undefined;
      const calledEvents: unknown[] = [];
      const result = await runStep(
        ctx,
        session,
        async (current) => {
          ctx.setVirtualContext(HandleEventKey, async (event) => {
            calledEvents.push(event);
          });
          generated = await generateText({
            model,
            prompt: "Delegate the work.",
            tools: buildToolSet({
              tools: new Map([
                [localTool.name, localTool],
                [remoteTool.name, remoteTool],
              ]),
            }),
          });
          return { next: null, session: current };
        },
        [backgroundToolExecutionProvider],
      );

      const pendingTasks = result.backgroundTasks ?? [];
      const handles = getAgentHandleStore(result.session.state)?.handles ?? [];
      if (pendingTasks.length !== 3) throw new Error("Three durable tasks were not committed.");
      if (handles.some((handle) => handle.phase !== "addressed") || handles.length !== 3) {
        throw new Error("Three child addresses were not committed.");
      }

      try {
        expect(generated?.toolResults).toHaveLength(3);
        expect(generated?.toolResults.map((toolResult) => toolResult.output)).toEqual(
          expect.arrayContaining(
            pendingTasks.map((task) =>
              expect.objectContaining({ status: "working", taskId: task.taskId }),
            ),
          ),
        );
        expect(new Set(handles.map((handle) => handle.identity.id)).size).toBe(3);
        expect(calledEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({ name: "agent" }),
              type: "subagent.called",
            }),
            expect.objectContaining({
              data: expect.objectContaining({
                childSessionId: "remote-child",
                name: "reviewer",
                remote: {
                  resolverId: remoteNode.nodeId,
                  url: remoteNode.url,
                },
              }),
              type: "subagent.called",
            }),
            ...pendingTasks.map((task) =>
              expect.objectContaining({
                data: expect.objectContaining({
                  backgroundTask: { status: "working", taskId: task.taskId },
                }),
                type: "subagent.completed",
              }),
            ),
          ]),
        );
        expect(calledEvents).toHaveLength(6);
        expect(handles).toContainEqual(
          expect.objectContaining({
            address: expect.objectContaining({ kind: "agent/remote", sessionId: "remote-child" }),
          }),
        );
        const remoteReceipt = generated?.toolResults.find(
          (toolResult) => toolResult.toolName === "reviewer",
        )?.output;
        const remoteTaskId =
          typeof remoteReceipt === "object" &&
          remoteReceipt !== null &&
          "taskId" in remoteReceipt &&
          typeof remoteReceipt.taskId === "string"
            ? remoteReceipt.taskId
            : undefined;
        const remoteTaskIndex = pendingTasks.findIndex((task) => task.taskId === remoteTaskId);
        expect(remoteTaskIndex).toBeGreaterThanOrEqual(0);

        await acknowledgeDelegatedTasksStep({ tasks: pendingTasks });
        const localTasks = pendingTasks.filter((_task, index) => index !== remoteTaskIndex);
        await Promise.all(localTasks.map((task) => getRun(task.taskRunId).returnValue));
        const views = await Promise.all(
          pendingTasks.map((task) => readLatestTaskView({ taskRunId: task.taskRunId })),
        );
        expect(views).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              lastOutput: {
                data: expect.stringContaining("background-child-a"),
                type: "result",
              },
              status: "completed",
            }),
            expect.objectContaining({
              lastOutput: {
                data: expect.stringContaining("background-child-b"),
                type: "result",
              },
              status: "completed",
            }),
            expect.objectContaining({
              status: "working",
            }),
          ]),
        );
        const remoteTask = pendingTasks[remoteTaskIndex];
        const remoteView = views[remoteTaskIndex];
        expect(remoteTask).toBeDefined();
        expect(
          remoteView === undefined ? undefined : readSubagentTaskMetadata(remoteView),
        ).toMatchObject({ mode: "remote", name: "reviewer" });
        expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
          callback: { token: remoteTask?.taskInboxToken },
        });
      } finally {
        await Promise.all(
          handles.flatMap((handle) =>
            handle.phase === "addressed"
              ? [
                  getRun(handle.address.sessionId)
                    .cancel()
                    .catch(() => {}),
                ]
              : [],
          ),
        );
        await Promise.all(
          pendingTasks.map((task) =>
            getRun(task.taskRunId)
              .cancel()
              .catch(() => {}),
          ),
        );
      }
    });
  }, 60_000);
});
