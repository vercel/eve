import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { agentRegistryProvider } from "#context/providers/agent-registry.js";
import { AgentRegistry, AgentRegistryKey } from "#subagents/registry/registry.js";
import { buildBaseToolContext } from "#context/build-base-tool-context.js";
import { SessionKey } from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { backgroundToolExecutionProvider } from "#execution/tasks/parent/tool-execution.js";
import { BackgroundToolExecutorKey } from "#harness/background-tools.js";
import { startTaskRun, waitForTaskCommandOwner } from "#execution/tasks/parent/run-parent.js";
import { setHarnessEmissionState } from "#harness/emission-state.js";
import type { HarnessSession } from "#harness/types.js";
import { defineTool } from "#tools/definition.js";
import { getAgentRegistryState } from "#subagents/registry/state.js";
import { applySessionAgentRegistryCommand } from "#subagents/registry/transitions.js";
import {
  projectRegisteredAgentViews,
  resolveAgentsAnnouncement,
} from "#subagents/registry/prompt.js";
import {
  planAgentDispatch,
  resolveAgentInvocationAction,
} from "#execution/tools/subagent/invoke-preparation.js";

vi.mock("#execution/tasks/parent/run-parent.js", () => ({
  sendTaskCommand: vi.fn(async () => "delivered"),
  startTaskRun: vi.fn(),
  waitForTaskCommandOwner: vi.fn(async () => ({ runId: "task-run" })),
}));

const remote = {
  key: "external-reviewer",
  description: "Reviews <changes>.",
  target: { kind: "remote" as const, url: "https://review.example" },
};

async function scope(restored?: HarnessSession) {
  const session =
    restored ??
    setHarnessEmissionState(
      {
        sessionId: "parent",
        continuationToken: "parent-token",
        history: [],
        agent: { dynamicModel: true, system: "", tools: [] },
        compaction: { recentWindowSize: 5, threshold: 10_000 },
      },
      { sessionStarted: true, sequence: 1, stepIndex: 0, turnId: "turn-1" },
    );
  const ctx = new ContextContainer();
  const definition = {
    kind: "subagent",
    name: "researcher",
    nodeId: "subagents/researcher",
    description: "Research",
  };
  ctx.set(BundleKey, {
    turnAgent: {},
    resolvedAgent: { config: {} },
    subagentRegistry: {
      subagentsByName: new Map([["researcher", { definition }]]),
      subagentsByNodeId: new Map([[definition.nodeId, { definition }]]),
    },
  } as never);
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: session.sessionId,
    turn: { id: "turn-1", sequence: 1 },
  });
  const created = await agentRegistryProvider.create(ctx, session);
  if (!created) throw new Error("Missing registry");
  const registry = created.value;
  ctx.setVirtualContext(AgentRegistryKey, registry);
  const background = await backgroundToolExecutionProvider.create(ctx, session);
  if (!background) throw new Error("Missing task executor");
  ctx.setVirtualContext(BackgroundToolExecutorKey, background.value);
  const run = <T>(callback: (toolContext: ReturnType<typeof buildBaseToolContext>) => T) =>
    contextStorage.run(ctx, () =>
      callback(buildBaseToolContext({ options: { toolCallId: "tool-1" }, toolName: "discover" })),
    );
  return {
    ctx,
    registry,
    run,
    session,
    commit: () => backgroundToolExecutionProvider.commit!(background.value, session),
  };
}

describe("session agent registration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("automatically registers static agents without starting a task", async () => {
    const { registry, commit } = await scope();
    expect(registry.entries).toMatchObject([
      { phase: "registered", identity: { name: "researcher" } },
    ]);
    expect(getAgentRegistryState((await commit()).state)?.handles).toEqual(registry.entries);
    expect(startTaskRun).not.toHaveBeenCalled();
  });

  it("commits registration edits and invocation transitions from one collection", async () => {
    const instance = await scope();
    const ref = instance.registry.register(remote);
    instance.registry.dispatch({
      kind: "reserve",
      identity: instance.registry.resolve(ref.id).identity,
      operationId: "operation-1",
      ownerId: "task-1",
    });
    instance.registry.update(ref, "Updated while starting");
    instance.registry.dispatch({
      kind: "confirm",
      operationId: "operation-1",
      ownerId: "task-1",
      address: {
        kind: "agent/remote",
        sessionId: "remote-session",
        url: remote.target.url,
        callbackBaseUrl: "https://parent.example",
      },
    });
    const resumed = await scope(JSON.parse(JSON.stringify(await instance.commit())));
    expect(resumed.registry.resolve(ref.id)).toMatchObject({
      phase: "claimed",
      ownerId: "task-1",
      identity: { registration: { description: "Updated while starting" } },
      address: { sessionId: "remote-session" },
    });
    resumed.registry.dispatch({ kind: "release-owner", ownerId: "task-1" });
    expect(resumed.registry.resolve(ref.id)).toMatchObject({
      phase: "available",
      identity: { registration: { description: "Updated while starting", visible: true } },
      address: { sessionId: "remote-session" },
    });
    const again = await scope(JSON.parse(JSON.stringify(await resumed.commit())));
    expect(again.registry.register({ ...remote, description: "Updated while starting" })).toEqual(
      ref,
    );
  });

  it("preserves the session on a read-only registry command", async () => {
    const instance = await scope();
    const committed = await instance.commit();
    const registry = new AgentRegistry(instance.ctx, committed);
    const entries = registry.entries;
    expect(registry.dispatch({ kind: "read" })).toEqual({ kind: "ready" });
    expect(registry.entries).toBe(entries);
    expect(registry.commit(committed)).toBe(committed);
  });

  it("can explicitly register the root-copy destination", async () => {
    const instance = await scope();
    const ref = instance.registry.register({
      key: "root-copy",
      description: "Delegate to a root copy",
      target: { kind: "agent", name: "agent" },
    });
    expect(instance.registry.resolve(ref.id).identity).toMatchObject({
      name: "agent",
      nodeId: "__root__",
    });
  });

  it("registers and invokes from an ordinary defineTool callback through the task executor", async () => {
    const instance = await scope();
    const tool = defineTool({
      description: "Discover an agent and delegate work.",
      inputSchema: { type: "object" },
      execute(_input, ctx) {
        const handle = ctx.registerAgent(remote);
        return ctx.agent(handle, { message: "Review this change." });
      },
    });
    const receipt = await instance.run((ctx) =>
      tool.execute(
        {},
        {
          ...ctx,
          getToken: vi.fn(),
          requireAuth: () => {
            throw new Error("Not used");
          },
        },
      ),
    );
    if (!("agentId" in receipt)) throw new Error("Expected task receipt");
    expect(receipt).toMatchObject({
      status: "working",
      agentId: expect.any(String),
      taskId: expect.any(String),
    });
    expect(startTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: expect.objectContaining({
          input: { agentId: receipt.agentId, message: "Review this change." },
          toolName: remote.key,
        }),
      }),
    );
    expect(waitForTaskCommandOwner).toHaveBeenCalledOnce();
    expect(getAgentRegistryState((await instance.commit()).state)?.handles).toContainEqual(
      expect.objectContaining({
        phase: "reserved",
        identity: expect.objectContaining({
          id: receipt.agentId,
          registration: expect.objectContaining({ key: remote.key }),
        }),
      }),
    );
  });

  it("can populate from an external-source result without returning handles or calling agents", async () => {
    const instance = await scope();
    const readDirectory = vi.fn(async () => JSON.parse(JSON.stringify([remote])));
    const result = await instance.run(async (ctx) => {
      for (const entry of await readDirectory()) ctx.registerAgent(entry);
      return { loaded: 1 };
    });
    expect(result).toEqual({ loaded: 1 });
    expect(startTaskRun).not.toHaveBeenCalled();
    const committed = await instance.commit();
    const resumed = await scope(JSON.parse(JSON.stringify(committed)));
    const view = resolveAgentsAnnouncement({
      messages: [],
      store: undefined,
      agentViews: projectRegisteredAgentViews(resumed.registry.entries),
    });
    expect(view).toContain("external-reviewer");
    expect(view).toContain("Reviews &lt;changes&gt;");
    expect(view).not.toContain(remote.target.url);
  });

  it("updates advertisements, removes access, and never reuses an unregistered handle ID", async () => {
    const instance = await scope();
    await instance.run(async (ctx) => {
      const handle = ctx.registerAgent(remote);
      ctx.updateAgent(handle, "Updated description");
      expect(projectRegisteredAgentViews(instance.registry.entries)).toContainEqual(
        expect.objectContaining({ statusLine: expect.stringContaining("Updated description") }),
      );
      ctx.unregisterAgent(handle);
      await expect(ctx.agent(handle, { message: "stale" })).rejects.toThrow(
        "Unknown or unregistered",
      );
      expect(
        projectRegisteredAgentViews(instance.registry.entries).some(
          (view) => view.id === handle.id,
        ),
      ).toBe(false);
      expect(ctx.registerAgent(remote).id).not.toBe(handle.id);
    });
    expect(startTaskRun).not.toHaveBeenCalled();
  });

  it("registers idempotently, rejects conflicts, and gives different sessions different IDs", async () => {
    const instance = await scope();
    const first = instance.registry.register(remote);
    expect(instance.registry.register(remote)).toEqual(first);
    expect(
      instance.registry.register({ ...remote, target: { url: remote.target.url, kind: "remote" } }),
    ).toEqual(first);
    expect(() => instance.registry.register({ ...remote, description: "different" })).toThrow(
      "different content",
    );
    const other = new AgentRegistry(instance.ctx, { ...instance.session, sessionId: "other" });
    expect(other.register(remote)).not.toEqual(first);
    expect(() => other.resolve(first.id)).toThrow("Unknown or unregistered");
  });

  it("rejects removed references from workflow resolution while accepted tasks retain their destination", async () => {
    const instance = await scope();
    const ref = instance.registry.register({
      key: "alias",
      description: "Research",
      target: { kind: "agent", name: "researcher" },
    });
    const identity = instance.registry.resolve(ref.id).identity;
    instance.registry.dispatch({ kind: "reserve", identity, operationId: "op", ownerId: "task" });
    instance.registry.unregister(ref);
    const request = {
      ctx: instance.ctx,
      handles: instance.registry.entries,
      input: { target: ref.id, message: "Continue" },
      invocationId: "call",
    };
    expect(() => resolveAgentInvocationAction(request)).toThrow("Unknown or unregistered");
    expect(resolveAgentInvocationAction({ ...request, allowUnregistered: true })).toMatchObject({
      input: { agentId: ref.id },
      name: "researcher",
    });
  });

  it("does not restore removed static destinations on resume and allows discovery to replace entries", async () => {
    const instance = await scope();
    for (const handle of instance.registry.entries)
      instance.registry.unregister({ id: handle.identity.id });
    for (let i = 0; i < 140; i++) {
      instance.registry.unregister(
        instance.registry.register({ ...remote, key: `destination-${i}` }),
      );
    }
    const resumed = await scope(await instance.commit());
    expect(resumed.registry.entries).toEqual([]);
  });

  it("keeps registration idempotent after serialization removes undefined optional fields", async () => {
    const instance = await scope();
    const destination = { ...remote, target: { ...remote.target, sessionId: undefined } };
    const ref = instance.registry.register(destination);
    const resumed = await scope(JSON.parse(JSON.stringify(await instance.commit())));
    expect(resumed.registry.register(destination)).toEqual(ref);
  });

  it("preserves registration after a failed fresh dispatch and the existing address after session expiry", async () => {
    const instance = await scope();
    const ref = instance.registry.register(remote);
    let session = await instance.commit();
    const identity = instance.registry.resolve(ref.id).identity;
    session = applySessionAgentRegistryCommand(session, {
      kind: "reserve",
      identity,
      operationId: "op",
      ownerId: "task",
    }).session;
    session = applySessionAgentRegistryCommand(session, {
      kind: "remove",
      agentId: ref.id,
      ownerId: "task",
    }).session;
    expect(
      getAgentRegistryState(session.state)?.handles.find((handle) => handle.identity.id === ref.id)
        ?.phase,
    ).toBe("registered");
    session = applySessionAgentRegistryCommand(session, {
      kind: "reserve",
      identity,
      operationId: "op2",
      ownerId: "task2",
    }).session;
    session = applySessionAgentRegistryCommand(session, {
      kind: "confirm",
      operationId: "op2",
      ownerId: "task2",
      address: {
        kind: "agent/remote",
        url: remote.target.url,
        sessionId: "expired",
        callbackBaseUrl: "https://parent.example",
        credentialResolver: {},
      },
    }).session;
    session = applySessionAgentRegistryCommand(session, {
      kind: "remove",
      agentId: ref.id,
      ownerId: "task2",
    }).session;
    expect(
      getAgentRegistryState(session.state)?.handles.find((handle) => handle.identity.id === ref.id),
    ).toMatchObject({ phase: "available", address: { sessionId: "expired" } });
  });

  it("resolves a remote destination absent from the compiled registry into the existing dispatch planner", async () => {
    const instance = await scope();
    const ref = instance.registry.register(remote);
    const action = resolveAgentInvocationAction({
      ctx: instance.ctx,
      handles: instance.registry.entries,
      input: { target: ref.id, message: "Review" },
      invocationId: "call",
    });
    expect(action).toMatchObject({
      kind: "remote-agent-call",
      remoteAgentName: remote.key,
      input: { agentId: ref.id },
    });
    expect(
      resolveAgentInvocationAction({
        ctx: instance.ctx,
        handles: instance.registry.entries,
        input: { target: remote.key, message: "Review" },
        invocationId: "call",
      }),
    ).toEqual(action);
    const plan = planAgentDispatch({
      action,
      bundle: instance.ctx.require(BundleKey),
      ctx: instance.ctx,
      session: await instance.commit(),
    });
    expect(plan).toMatchObject({
      kind: "start",
      target: { kind: "remote", dynamicRemoteAgent: { publicUrl: true, url: remote.target.url } },
    });
  });

  it.each([
    "http://public.example",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://user:secret@public.example",
  ])("rejects unsafe remote registration %s before any invocation", async (url) => {
    const instance = await scope();
    expect(() =>
      instance.registry.register({ ...remote, target: { kind: "remote", url } }),
    ).toThrow();
    expect(startTaskRun).not.toHaveBeenCalled();
  });
});
