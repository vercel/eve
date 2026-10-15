import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createAgentSessions } from "#execution/agent-sessions/session.js";
import { createRunUsageTally } from "#execution/agent-sessions/usage.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { handleSandboxRequest } from "#execution/session-sandbox-request.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import type { SandboxRequestPayload } from "#execution/session-inbox/inbox.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox, defineParentSandbox } from "#public/definitions/sandbox.js";
import { defineState } from "#public/definitions/state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { HarnessSession } from "#harness/types.js";

const runtime = vi.hoisted(() => ({
  bundles: new Map<string, unknown>(),
  hooks: new Map<string, (value: unknown) => void>(),
  createSession: vi.fn(),
  request: vi.fn(),
  count: 0,
}));
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: async () => null,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: async ({ nodeId }: { nodeId?: string }) =>
    runtime.bundles.get(nodeId ?? "__root__"),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: () => ({ createSession: runtime.createSession }),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: async (token: string, value: unknown) => {
    const hook = runtime.hooks.get(token);
    if (hook !== undefined) hook(value);
    else await runtime.request(token, value);
  },
}));
vi.mock("#compiled/@workflow/core/index.js", async (original) => ({
  ...(await original<typeof import("#compiled/@workflow/core/index.js")>()),
  getStepMetadata: () => ({ attempt: 1 }),
  createHook: () => {
    const token = `sandbox-test-${++runtime.count}`;
    const promise = new Promise<unknown>((resolve) => runtime.hooks.set(token, resolve));
    return Object.assign(promise, {
      token,
      getConflict: async () => null,
      dispose: async () => {
        runtime.hooks.delete(token);
      },
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: await promise }) }),
    });
  },
}));

afterEach(async () => {
  await shutdownActiveSandboxHandles();
  runtime.bundles.clear();
  runtime.hooks.clear();
  vi.clearAllMocks();
});

function sandboxFixture(name: string, ownerId: string) {
  const creator = defineState(`creator-${name}`, () => "");
  const start = vi.fn(async (_context: unknown) => ({
    handle: {
      sandbox: mockSandbox().session,
      onSandboxDelete: async () => {},
      onRuntimeShutdown: async () => {},
      onSandboxStop: async () => {},
    },
    state: { id: name },
  }));
  const provider = defineSandboxProvider<undefined, { networkPolicy: string }>({
    name,
    environment: () => ({
      prepare: async () => null,
      start,
      resume: async () => ({
        sandbox: mockSandbox().session,
        onSandboxDelete: async () => {},
        onRuntimeShutdown: async () => {},
        onSandboxStop: async () => {},
      }),
    }),
  });
  const environment = provider.environment();
  const setup = vi.fn();
  const selector = defineSandbox(async (ctx) => {
    expect(ctx.session.id).toBe(ownerId);
    expect(ctx.session.auth.current?.principalId).toBe("delegating-user");
    creator.update(() => ctx.session.auth.current?.principalId ?? "");
    setup();
    return await environment.open({ networkPolicy: "deny-all" });
  });
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        kind: "independent",
        environment,
        selector,
        logicalPath: "sandbox.ts",
        revisionHash: name,
        sourceId: name,
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { registry, start, setup, creator };
}

function inherited(registry: RuntimeSandboxRegistry): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        kind: "parent",
        selector: defineParentSandbox(),
        logicalPath: "sandbox.ts",
        revisionHash: "child",
        sourceId: "child",
        sourceKind: "module",
      },
      inheritance: {
        definition: registry.sandbox.definition,
        nodeId: "__root__",
        workspaceResourceRoot: registry.sandbox.workspaceResourceRoot,
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}

describe("shared sandbox at child start", () => {
  it.each(["builtin", "declared", "authored-workflow", "independent-parent"])(
    "%s initializes the nearest owner's context before parallel children start",
    async (path) => {
      const ownerId = path === "independent-parent" ? "parent-owner" : "root-owner";
      const root = sandboxFixture(`root-${path}`, "root-owner");
      const owner =
        path === "independent-parent" ? sandboxFixture(`parent-${path}`, ownerId) : root;
      const registry = inherited(owner.registry);
      const source = createBundledRuntimeCompiledArtifactsSource();
      const child = {
        definition: { kind: "subagent", name: "worker", nodeId: "worker" },
      };
      const bundle = {
        compiledArtifactsSource: source,
        nodeId: path === "independent-parent" ? "parent" : undefined,
        resolvedAgent: {},
        turnAgent: { id: "test", instructions: [], tools: [], model: { id: "test" } },
        graph: {
          root: {
            nodeId: path === "independent-parent" ? "parent" : "__root__",
            sandboxRegistry: owner.registry,
          },
          nodesByNodeId: new Map([["worker", { sandboxRegistry: registry }]]),
        },
        subagentRegistry: {
          subagentsByName: new Map([["worker", child]]),
          subagentsByNodeId: new Map([["worker", child]]),
        },
      } as unknown as CompiledBundle;
      runtime.bundles.set(bundle.nodeId ?? "__root__", bundle);
      const ctx = new ContextContainer();
      ctx.set(BundleKey, bundle);
      ctx.set(SessionIdKey, ownerId);
      ctx.set(AuthKey, {
        attributes: {},
        authenticator: "test",
        principalId: "delegating-user",
        principalType: "user",
      });
      const session: HarnessSession = {
        sessionId: ownerId,
        continuationToken: "owner-token",
        history: [],
        agent: { modelReference: { id: "test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
      };
      let cursor = new SessionStateCursor({
        serializedContext: serializeContext(ctx),
        sessionState: createDurableSessionState({ session }),
        history: [],
        sessionWritable: new WritableStream(),
        inbox: { claimSessionHooks: async () => {} },
      });
      // The session inbox services requests sequentially, including parallel child starts.
      let requests = Promise.resolve();
      runtime.request.mockImplementation((token: string, message: SandboxRequestPayload) => {
        expect(token).toBe(`eve:inbox:v1:eve:session:${ownerId}:inbox`);
        expect(message).toEqual({ kind: "sandbox-request", replyTo: expect.any(String) });
        const request = requests.then(() => handleSandboxRequest({ cursor, message }));
        requests = request.then(() => {});
        return request;
      });
      // Root paths use the root provider, independent-parent uses only that parent's provider.
      runtime.createSession.mockImplementation(async (input) => {
        expect(owner.setup).toHaveBeenCalledOnce();
        const access = await ensureSandboxAccess({
          compiledArtifactsSource: source,
          nodeId: "worker",
          registry,
          inherited: true,
          ownsSandbox: false,
          sessionId: ownerId,
          state: input.adapter.state.parentSandboxState,
        });
        const childContext = new ContextContainer();
        childContext.set(SessionKey, {
          sessionId: "child-session",
          auth: { current: null, initiator: null },
          turn: { id: "turn", sequence: 1 },
        });
        await contextStorage.run(childContext, () => access.get());
        return { sessionId: "child-session" };
      });
      const run = {
        auth: {
          current: {
            attributes: {},
            authenticator: "test",
            principalId: "workflow-caller",
            principalType: "user",
          },
          initiator: null,
        },
        agentContext: {
          agents: {},
          bundle: {
            nodeId: bundle.nodeId,
            source: serializeDurableCompiledArtifactsSource(source),
          },
          dynamicSelections: {},
          limits: {},
          trace: {},
          parent: {
            callId: "call",
            rootSessionId: "root-owner",
            sessionId: ownerId,
            turn: { id: "turn", sequence: 1 },
          },
          sandbox: { sessionId: ownerId },
        },
        from: {
          callId: "call",
          toolName: path === "authored-workflow" ? "authored" : "agent",
          runId: "run",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn",
          input: {},
        },
        owner: { send: async () => {} },
      } as unknown as WorkflowToolRunContext;
      const children = createAgentSessions(run, createRunUsageTally());
      const target = path === "builtin" ? "agent" : "worker";
      await Promise.all([children.open(target).send("work"), children.open(target).send("work")]);
      expect(owner.setup).toHaveBeenCalledOnce();
      expect(owner.start).toHaveBeenCalledOnce();
      expect(owner.start).toHaveBeenCalledWith(
        expect.any(Object),
        { networkPolicy: "deny-all" },
        null,
      );
      if (owner !== root) expect(root.setup).not.toHaveBeenCalled();
      const durableContext = await deserializeContext(cursor.serializedContext);
      await contextStorage.run(durableContext, async () =>
        expect(owner.creator.get()).toBe("delegating-user"),
      );
      expect(durableContext.get(AuthKey)?.principalId).toBe("delegating-user");
      expect(readDurableSession(cursor.sessionState).sandboxState?.session).toBeTruthy();
      cursor = new SessionStateCursor({
        serializedContext: serializeContext(durableContext),
        sessionState: cursor.sessionState,
        history: [],
        sessionWritable: new WritableStream(),
        inbox: { claimSessionHooks: async () => {} },
      });
      await children.open(target).send("after resume");
      expect(owner.setup).toHaveBeenCalledOnce();
      expect(owner.start).toHaveBeenCalledOnce();
    },
  );
});
