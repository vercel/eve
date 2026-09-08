import { asSchema, jsonSchema, type ToolSet } from "ai";
import * as serialization from "#context/serialize.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { createStepStartedEvent } from "#protocol/message.js";
import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { never, always } from "#tools/approval/policies.js";
import type { ResolvedDynamicToolResolver } from "#runtime/types.js";
import {
  AuthKey,
  SessionIdKey,
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import type { CurrentDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import {
  CallbackBaseUrlKey,
  getAuthorizationResults,
  getHookUrl,
  requestAuthorization,
} from "#harness/authorization.js";
import { buildToolSet } from "#harness/tools.js";
import { applyCodeModeTool, claimsForCodeMode } from "#harness/code-mode.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  registerDurableDynamicCallback,
  stampDurableDynamicToolCallbacks,
} from "#tools/durable-callbacks.js";
import * as sandbox from "#shared/workflow-sandbox.js";
import { defineTool } from "#tools/definition.js";

const state = vi.hoisted(() => ({
  ctx: undefined as ContextContainer | undefined,
  tools: new Map<string, HarnessToolDefinition>(),
}));
vi.mock("#context/serialize.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deserializeContext: async () => state.ctx,
  serializeContext: (ctx: ContextContainer) =>
    Object.fromEntries(
      [...ctx.entries()]
        .filter(([key]) => key.name !== "test.bundle" && key.name !== "eve.connectionRegistry")
        .map(([key, value]) => [key.name, value]),
    ),
}));
vi.mock("#runtime/sessions/runtime-context-keys.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return { BundleKey: new ContextKey("test.bundle"), ChannelKey: new ContextKey("test.channel") };
});
vi.mock("#context/providers/connection.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return {
    connectionProvider: { key: new ContextKey("test.connection"), create: () => undefined },
  };
});
vi.mock("#context/providers/sandbox.js", async () => {
  const { ContextKey } = await import("#context/key.js");
  return { sandboxProvider: { key: new ContextKey("test.sandbox"), create: () => undefined } };
});
vi.mock("#execution/node-step.js", () => ({
  createNodeHarnessTools: () => state.tools,
  buildRuntimeIdentity: () => ({ agentId: "test", eveVersion: "test" }),
}));
vi.mock("#execution/durable-session-store.js", () => ({
  readDurableSession: async () => ({
    state: {
      "eve.harness.workflowContinuationSecurity": { version: 1, signingKey: "a".repeat(43) },
    },
  }),
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: () => ({ turnAgent: {} }),
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: () => ({
    agent: { modelReference: { id: "test" } },
    history: [],
    state: {
      "eve.harness.workflowContinuationSecurity": { version: 1, signingKey: "a".repeat(43) },
    },
  }),
}));
vi.mock("#runtime/graph.js", () => ({ getResolvedRuntimeAgentNode: () => ({}) }));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({ buildDynamicSubagentTools: () => [] }));

const { BundleKey } = await import("#runtime/sessions/runtime-context-keys.js");
const { executeCodeModeToolStep, runCodeModeProgramStep } =
  await import("#execution/code-mode/program-step.js");

function definition(
  name: string,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    name,
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    execute: async () => "ok",
    ...extra,
  };
}

function nested(
  name: string,
  authorizationResults?: Parameters<typeof executeCodeModeToolStep>[0]["authorizationResults"],
) {
  return executeCodeModeToolStep({
    authorizationHookToken: "nested-auth",
    authorizationResults,
    event: { sequence: 1, stepIndex: 2, turnId: "turn" },
    serializedContext: {},
    sessionState: {} as never,
    toolCallId: "inner",
    toolName: name,
    toolInput: {},
  });
}

function dynamic(value: string): CurrentDynamicToolMetadata {
  return {
    name: "lookup",
    description: "lookup",
    inputSchema: { type: "object" },
    resolverSlug: "lookup",
    entryKey: "lookup",
    callbacks: { execute: { closure: { value } } },
  };
}

beforeEach(() => {
  state.ctx = new ContextContainer();
  state.ctx.set(AuthKey, null);
  state.ctx.set(SessionIdKey, "parent-session");
  state.ctx.set(CallbackBaseUrlKey, "https://app.example");
  state.ctx.set(BundleKey, { graph: {}, nodeId: "root", resolvedAgent: {} } as never);
  state.tools = new Map();
});

describe("executeCodeModeToolStep", () => {
  it.each([
    { policy: "unset", approval: undefined, allowed: true },
    { policy: "never", approval: never(), allowed: true },
    { policy: "always", approval: always(), allowed: false },
  ])(
    "restores and executes a discovered connection with $policy approval after a cold start",
    async ({ approval, allowed }) => {
      const executeTool = vi.fn(async () => ({ issues: ["issue-1"] }));
      const resolver: ResolvedDynamicToolResolver = {
        slug: "connection_search",
        logicalPath: "tools/connection_search.ts",
        sourceId: "tools/connection_search",
        sourceKind: "module",
        eventNames: ["step.started"],
        events: { "step.started": resolveConnectionSearchDynamicTools },
      };
      state.ctx!.set(BundleKey, {
        graph: {},
        nodeId: "root",
        resolvedAgent: { dynamicToolResolvers: [resolver] },
      } as never);
      state.ctx!.set(ConnectionRegistryKey, {
        dispose: async () => {},
        getConnectionApproval: () => approval,
        getConnectionNames: () => ["tracker"],
        getConnections: () => [
          {
            connectionName: "tracker",
            description: "Issues",
            protocol: "mcp",
            logicalPath: "connections/tracker.ts",
            sourceId: "connections/tracker",
            sourceKind: "module",
            url: "https://tracker.example/mcp",
          },
        ],
        getClient: () => ({
          close: async () => {},
          connect: async () => {},
          getTools: async () => ({}),
          executeTool,
          getToolMetadata: async () => [
            { name: "list_issues", description: "List issues", inputSchema: { type: "object" } },
          ],
        }),
      });
      await contextStorage.run(state.ctx!, async () => {
        const initial = await resolveConnectionSearchDynamicTools();
        await (initial!.connection_search as ReturnType<typeof defineTool>).execute(
          { keywords: "issues" },
          {} as never,
        );
        await dispatchDynamicToolEvent({
          ctx: state.ctx!,
          resolvers: [resolver],
          messages: [],
          event: createStepStartedEvent({
            modelId: "test",
            sequence: 1,
            stepIndex: 2,
            turnId: "turn",
          }),
        });
      });
      const registry = Reflect.get(globalThis, Symbol.for("eve:dynamic-tool-callbacks")) as Map<
        string,
        unknown
      >;
      registry.delete("tracker__list_issues");

      await expect(nested("tracker__list_issues")).resolves.toEqual(
        allowed
          ? { status: "completed", output: { issues: ["issue-1"] } }
          : {
              status: "failed",
              error: 'Tool "tracker__list_issues" is not available to code_mode in this session.',
            },
      );
      if (allowed) {
        expect(executeTool).toHaveBeenCalledExactlyOnceWith(
          "list_issues",
          {},
          expect.objectContaining({ callId: "inner" }),
        );
      } else {
        expect(executeTool).not.toHaveBeenCalled();
      }
      await expect(nested("connection_search")).resolves.toMatchObject({ status: "failed" });
    },
  );

  it("restores a missing callback with the dispatched step coordinates and closure", async () => {
    const tool = defineTool({
      description: "cold",
      inputSchema: { type: "object" },
      execute: () => "unused",
    });
    stampDurableDynamicToolCallbacks(tool, {
      execute: { callback: (closure) => closure.value, closure: { value: "new resolver value" } },
    });
    const resolver = vi.fn((_event: unknown) => ({ cold: tool }));
    state.ctx!.set(BundleKey, {
      graph: {},
      nodeId: "root",
      resolvedAgent: {
        dynamicToolResolvers: [
          { slug: "cold", eventNames: ["step.started"], events: { "step.started": resolver } },
        ],
      },
    } as never);
    state.ctx!.set(StepDynamicToolMetadataKey, [
      { ...dynamic("dispatched"), name: "cold", resolverSlug: "cold" },
    ]);
    await expect(nested("cold")).resolves.toEqual({ status: "completed", output: "dispatched" });
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver.mock.calls[0]?.[0]).toMatchObject({
      data: { sequence: 1, stepIndex: 2, turnId: "turn" },
    });
  });

  it("keeps ordinary background tools direct and rejects attempts to run them", async () => {
    const execute = vi.fn(async () => "done");
    state.tools.set("background", definition("background", { execution: "background", execute }));
    expect(claimsForCodeMode("background", state.tools)).toBe(false);
    await expect(nested("background")).resolves.toEqual({
      status: "failed",
      error: 'Tool "background" is not available to code_mode in this session.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the full authorization challenge and resumes with its matched callback", async () => {
    const challenge = {
      attemptId: "attempt",
      name: "service",
      challenge: { url: "https://idp.example/auth" },
      hookUrl: "https://app.example/cb",
      principal: { id: "user", type: "user" as const },
      resume: { verifier: "test" },
    };
    state.tools.set(
      "authorize",
      definition("authorize", {
        execute: async () => {
          expect(getHookUrl("service", "attempt")).toContain("nested-auth");
          const result = getAuthorizationResults()[0];
          return result === undefined
            ? requestAuthorization([challenge])
            : { resume: result.resume, callback: result.callback, principal: result.principal };
        },
      }),
    );
    await expect(nested("authorize")).resolves.toEqual({
      status: "authorization-required",
      challenges: [challenge],
    });
    const callback = { method: "GET", params: { code: "accepted" } };
    await expect(
      nested("authorize", [
        {
          name: "service",
          attemptId: "attempt",
          hookUrl: challenge.hookUrl,
          callback,
          principal: challenge.principal,
          resume: challenge.resume,
        },
      ]),
    ).resolves.toEqual({
      status: "completed",
      output: { resume: challenge.resume, callback, principal: challenge.principal },
    });
  });

  it("uses the advertised step override ahead of turn, session, and authored definitions", async () => {
    state.tools.set("lookup", definition("lookup", { execute: async () => "authored" }));
    registerDurableDynamicCallback({
      toolName: "lookup",
      phase: "execute",
      callback: (closure) => closure.value,
    });
    state.ctx!.set(StepDynamicToolMetadataKey, [dynamic("step")]);
    state.ctx!.set(TurnDynamicToolMetadataKey, [dynamic("turn")]);
    state.ctx!.set(SessionDynamicToolMetadataKey, [dynamic("session")]);
    const effective = buildResponseAuthorizationTools({
      authoredTools: state.tools,
      context: state.ctx,
    });
    const tools = buildToolSet({ tools: effective });
    state.tools.set(
      "code_mode",
      definition("code_mode", {
        execute: undefined,
        workflowId: "workflow//eve//codeModeWorkflow",
      }),
    );
    const applied = await applyCodeModeTool({
      continuationSecurity: { signingKey: "test" },
      harnessTools: new Map([...effective, ["code_mode", state.tools.get("code_mode")!]]),

      tools: {
        ...tools,
        ...buildToolSet({ tools: new Map([["code_mode", state.tools.get("code_mode")!]]) }),
      },
    });
    expect(applied.modelTools).not.toHaveProperty("lookup");
    await expect(nested("lookup")).resolves.toEqual({ status: "completed", output: "step" });
  });

  it("claims a dynamic tool even when no authored tool has its name", async () => {
    state.tools.set(
      "code_mode",
      definition("code_mode", {
        execute: undefined,
        workflowId: "workflow//eve//codeModeWorkflow",
      }),
    );
    registerDurableDynamicCallback({
      toolName: "lookup",
      phase: "execute",
      callback: (closure) => closure.value,
    });
    state.ctx!.set(StepDynamicToolMetadataKey, [dynamic("discovered")]);
    const harnessTools = buildResponseAuthorizationTools({
      authoredTools: state.tools,
      context: state.ctx,
    });
    const result = await applyCodeModeTool({
      continuationSecurity: { signingKey: "test" },
      harnessTools,

      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(Object.keys(result.modelTools)).toEqual(["code_mode"]);
    await expect(nested("lookup")).resolves.toEqual({ status: "completed", output: "discovered" });
  });
});

describe("runCodeModeProgramStep", () => {
  const input = {
    callId: "program",
    sessionState: {} as never,
    program: {
      js: "return 1;",

      toolCatalog: [],
      maxSubagents: 100,
    },
  };

  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    "uses pinned stubs without restoring tool context (resume=%s)",
    async (resume) => {
      const restore = vi
        .spyOn(serialization, "deserializeContext")
        .mockRejectedValue(new Error("Tool context must not be restored"));
      const execute = vi.fn().mockResolvedValue("result");
      const created = vi
        .spyOn(sandbox, "createWorkflowSandboxTool")
        .mockResolvedValue({ execute } as never);
      const continued = vi
        .spyOn(sandbox, "continueWorkflowSandboxInterrupt")
        .mockResolvedValue("result" as never);
      vi.spyOn(sandbox, "unwrapWorkflowSandboxResult").mockResolvedValue({
        status: "completed",
        output: "done",
      });
      const interrupt = vi
        .spyOn(sandbox, "requestWorkflowSandboxInterrupt")
        .mockReturnValue("parked" as never);
      const toolCatalog = [
        {
          name: "lookup",
          description: "Pinned lookup",
          inputSchema: { type: "object" },
          outputSchema: { type: "string" },
          target: "tool" as const,
        },
        {
          name: "researcher",
          description: "Pinned agent",
          inputSchema: { type: "object" },
          outputSchema: null,
          target: "agent" as const,
        },
        {
          name: "gated",
          description: "Direct only",
          inputSchema: { type: "object" },
          outputSchema: null,
          target: "direct" as const,
        },
      ];
      await expect(
        runCodeModeProgramStep({
          ...input,
          program: { ...input.program, toolCatalog },
          ...(resume
            ? {
                resume: [
                  {
                    interrupt: {} as never,
                    resolution: { status: "completed" as const, output: null },
                  },
                ],
              }
            : {}),
        }),
      ).resolves.toEqual({ status: "completed", output: "done" });
      expect(restore).not.toHaveBeenCalled();
      const tools = (
        resume ? continued.mock.calls[0]![0].tools : created.mock.calls[0]![0].hostTools
      ) as ToolSet;
      expect(Object.keys(tools).sort()).toEqual([
        "describe_tools",
        "lookup",
        "researcher",
        "search_tools",
      ]);
      expect(tools.lookup!.description).toBe("Pinned lookup");
      expect(asSchema(tools.lookup!.inputSchema).jsonSchema).toEqual({ type: "object" });
      expect(asSchema(tools.lookup!.outputSchema!).jsonSchema).toEqual({ type: "string" });
      for (const name of ["lookup", "researcher"]) {
        await tools[name]!.execute!({ query: "hello" } as never, {
          toolCallId: name,
          messages: [],
          context: {},
        });
        expect(interrupt).toHaveBeenLastCalledWith({
          kind: "eve.code-mode-call",
          target: name === "lookup" ? "tool" : "agent",
          toolName: name,
          toolInput: { query: "hello" },
        });
      }
    },
  );

  it("applies every batch resolution to the updated continuation in order", async () => {
    const interrupts = [0, 1, 2].map((revision) => ({ revision }) as never);
    const resolutions = [
      { status: "completed" as const, output: "first" },
      { status: "failed" as const, error: "second failed" },
      { status: "completed" as const, output: "third" },
    ];
    const continued = vi
      .spyOn(sandbox, "continueWorkflowSandboxInterrupt")
      .mockResolvedValue("raw" as never);
    vi.spyOn(sandbox, "unwrapWorkflowSandboxResult")
      .mockResolvedValueOnce({ status: "interrupted", interrupt: interrupts[1]! })
      .mockResolvedValueOnce({ status: "interrupted", interrupt: interrupts[2]! })
      .mockResolvedValueOnce({ status: "completed", output: "done" });
    vi.spyOn(sandbox, "getWorkflowSandboxPendingInterrupts").mockImplementation((interrupt) => [
      interrupt,
    ]);

    await expect(
      runCodeModeProgramStep({
        ...input,
        resume: resolutions.map((resolution) => ({ interrupt: interrupts[0]!, resolution })),
      }),
    ).resolves.toEqual({ status: "completed", output: "done" });

    expect(
      continued.mock.calls.map(([call]) => ({
        interrupt: call.interrupt,
        resolution: call.resolution,
      })),
    ).toEqual(
      resolutions.map((resolution, index) => ({ interrupt: interrupts[index], resolution })),
    );
  });

  it.each([false, true])("settles a program failure as data (resume=%s)", async (resume) => {
    const failure = Object.assign(new Error("invalid program"), { code: "RUN_USER_SOURCE_ERROR" });
    const execute = vi.fn().mockRejectedValue(failure);
    vi.spyOn(sandbox, "createWorkflowSandboxTool").mockResolvedValue({ execute } as never);
    const continued = vi
      .spyOn(sandbox, "continueWorkflowSandboxInterrupt")
      .mockRejectedValue(failure);
    await expect(
      runCodeModeProgramStep({
        ...input,
        ...(resume
          ? {
              resume: [
                {
                  interrupt: {} as never,
                  resolution: { status: "completed" as const, output: null },
                },
              ],
            }
          : {}),
      }),
    ).resolves.toEqual({ status: "failed", error: "invalid program" });
    expect(resume ? continued : execute).toHaveBeenCalledOnce();
  });

  it("rethrows a worker failure so workflow can retry it", async () => {
    const failure = Object.assign(new Error("worker failed"), { code: "RUN_ERROR" });
    vi.spyOn(sandbox, "createWorkflowSandboxTool").mockRejectedValue(failure);
    await expect(runCodeModeProgramStep(input)).rejects.toBe(failure);
  });
});

describe("nested tool state across fresh contexts", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["todo", "file"])("preserves %s state across step boundaries", async (kind) => {
    const { resolveKey } = await import("#context/key.js");
    const { adoptCodeModeStateChanges } = await import("#execution/code-mode/state.js");
    const bundle = state.ctx!.require(BundleKey);
    vi.spyOn(serialization, "deserializeContext").mockImplementation(async (data) => {
      const ctx = new ContextContainer();
      ctx.set(BundleKey, bundle);
      for (const [name, value] of Object.entries(data)) {
        const key = resolveKey(name);
        if (key !== undefined) ctx.set(key, structuredClone(value));
      }
      return ctx;
    });
    let current = {
      serializedContext: serialization.serializeContext(state.ctx!),
      sessionState: {} as never,
    };
    async function invoke(name: string) {
      const outcome = await executeCodeModeToolStep({
        ...current,
        authorizationHookToken: "nested-auth",
        event: { sequence: 1, stepIndex: 2, turnId: "turn" },
        toolCallId: name,
        toolInput: {},
        toolName: name,
      });
      current = adoptCodeModeStateChanges(current, outcome.stateChanges ?? []) as typeof current;
      return outcome;
    }
    if (kind === "todo") {
      const { executeTodoTool } = await import("#execution/tools/todo.js");
      const todos = [{ content: "review", priority: "high" as const, status: "pending" as const }];
      state.tools.set(
        "write",
        definition("write", { execute: async () => executeTodoTool({ todos }) }),
      );
      state.tools.set("read", definition("read", { execute: async () => executeTodoTool({}) }));
      expect(await invoke("write")).toMatchObject({ status: "completed", output: { todos } });
      expect(await invoke("read")).toMatchObject({ status: "completed", output: { todos } });
    } else {
      const { executeReadFileOnSandbox } = await import("#execution/sandbox/read-file.js");
      const { executeWriteFileOnSandbox } = await import("#execution/sandbox/write-file.js");
      const fs = { readTextFile: async () => "original", writeTextFile: vi.fn() };
      state.tools.set(
        "read_file",
        definition("read_file", {
          execute: async () =>
            executeReadFileOnSandbox(fs as never, { filePath: "/workspace/probe.txt" }),
        }),
      );
      state.tools.set(
        "write_file",
        definition("write_file", {
          execute: async () =>
            executeWriteFileOnSandbox(fs as never, {
              filePath: "/workspace/probe.txt",
              content: "updated",
            }),
        }),
      );
      expect(await invoke("read_file")).toMatchObject({ status: "completed" });
      expect(await invoke("write_file")).toMatchObject({
        status: "completed",
        output: { existed: true },
      });
      expect(fs.writeTextFile).toHaveBeenCalledOnce();
    }
    expect(current.serializedContext).not.toHaveProperty("eve.authorizationHookToken");
  });
});
