import { jsonSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { defineTool } from "#tools/definition.js";

const state = vi.hoisted(() => ({
  ctx: undefined as ContextContainer | undefined,
  tools: new Map<string, HarnessToolDefinition>(),
}));
vi.mock("#context/serialize.js", () => ({ deserializeContext: async () => state.ctx }));
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
vi.mock("#execution/durable-session-store.js", () => ({ readDurableSession: async () => ({}) }));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: () => ({ turnAgent: {} }),
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: () => ({
    agent: { modelReference: { id: "test" } },
    history: [],
    state: undefined,
  }),
}));
vi.mock("#runtime/graph.js", () => ({ getResolvedRuntimeAgentNode: () => ({}) }));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({ buildDynamicSubagentTools: () => [] }));

const { BundleKey } = await import("#runtime/sessions/runtime-context-keys.js");
const { executeCodeModeToolStep } = await import("#execution/code-mode/program-step.js");

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
    callId: "outer",
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
      mode: "eager",
      tools: {
        ...tools,
        ...buildToolSet({ tools: new Map([["code_mode", state.tools.get("code_mode")!]]) }),
      },
    });
    expect(applied.claimedToolNames).toEqual(["lookup"]);
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
      mode: "eager",
      tools: buildToolSet({ tools: harnessTools }),
    });
    expect(result.claimedToolNames).toEqual(["lookup"]);
    expect(Object.keys(result.modelTools)).toEqual(["code_mode"]);
    await expect(nested("lookup")).resolves.toEqual({ status: "completed", output: "discovered" });
  });
});
