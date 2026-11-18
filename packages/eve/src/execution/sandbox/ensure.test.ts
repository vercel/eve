import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { importConversation, readLegacySnapshot } from "#execution/legacy-session/snapshot.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineParentSandbox, defineSandbox } from "#public/definitions/sandbox.js";
import {
  defineSandboxProvider,
  type SandboxAttachOptions,
  type SandboxSessionContext,
} from "#sandbox/provider.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";
import { markSandboxRunning, type SandboxState } from "#sandbox/state.js";
import type { SandboxCommandResult, SandboxRunOptions } from "#shared/sandbox-session.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

function fixture(
  options: {
    readonly check?: (
      options: SandboxRunOptions,
    ) => Promise<SandboxCommandResult> | SandboxCommandResult;
    readonly closable?: boolean;
    readonly idleTimeoutMs?: number | false;
    readonly returnCopy?: boolean;
    readonly setup?: () => void;
    readonly stopsIdle?: boolean;
  } = {},
) {
  const { returnCopy = false, setup } = options;
  const onSessionEnd = vi.fn(async () => {});
  const stopSandbox = vi.fn(async () => {});
  const closeSandbox = vi.fn(async () => {});
  const stopIdleSandbox = vi.fn(async (_options?: { readonly signal?: AbortSignal }) => {});
  const closeAttached = vi.fn(async () => {});
  const create = vi.fn(async () => {
    const { connection } = mockSandbox({ stop: stopSandbox });
    return options.closable === true ? { ...connection, close: closeSandbox } : connection;
  });
  const attach = vi.fn(
    async (_context: SandboxSessionContext, _state: unknown, _options: SandboxAttachOptions) => {
      const { connection } = mockSandbox({ run: options.check });
      return { close: closeAttached, spawn: connection.spawn, stop: stopIdleSandbox };
    },
  );
  const resume = vi.fn(async () => await create());
  const start = vi.fn(async (context: SandboxSessionContext) => ({
    connection: await create(),
    state: { key: context.session.id },
  }));
  const provider = defineSandboxProvider({
    name: "test",
    environment: () => ({
      onSessionEnd,
      ...(options.stopsIdle === true && { attach }),
      prepare: async () => null,
      start,
      resume,
    }),
  });
  const environment = provider.environment(
    options.idleTimeoutMs === undefined ? undefined : { idleTimeoutMs: options.idleTimeoutMs },
  );
  const selector = defineSandbox(async () => {
    const sandbox = await environment.open();
    setup?.();
    return returnCopy ? { ...sandbox } : sandbox;
  });
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        selector,
        revisionHash: "hash",
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return {
    attach,
    closeAttached,
    closeSandbox,
    create,
    onSessionEnd,
    registry,
    resume,
    start,
    stopIdleSandbox,
    stopSandbox,
  };
}
function upsertingFixture() {
  const live = new Map<string, ReturnType<typeof mockSandbox>>();
  const connect = (sessionId: string) => {
    let sandbox = live.get(sessionId);
    if (sandbox === undefined) {
      sandbox = mockSandbox();
      live.set(sessionId, sandbox);
    }
    return sandbox.connection;
  };
  const environment = defineSandboxProvider({
    name: "upserting",
    environment: () => ({
      onSessionEnd: async (context) => void live.delete(context.session.id),
      prepare: async () => null,
      start: async (context) => ({ connection: connect(context.session.id), state: null }),
      resume: async (context) => connect(context.session.id),
    }),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        selector: defineSandbox(() => environment.open()),
        revisionHash: "hash",
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return { live, registry };
}

async function open(
  registry: RuntimeSandboxRegistry,
  id = "session-1",
  state: Parameters<typeof ensureSandboxAccess>[0]["state"] = null,
  nodeId = "__root__",
  ownsSandbox?: boolean,
) {
  const context = new ContextContainer();
  context.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: id,
    turn: { id: "turn", sequence: 0 },
  });
  return await contextStorage.run(context, async () => {
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId,
      ownsSandbox,
      registry,
      sessionId: id,
      state,
    });
    return { access, sandbox: await access.get() };
  });
}
function inheritingChildRegistry(rootRegistry: RuntimeSandboxRegistry): RuntimeSandboxRegistry {
  const parent = rootRegistry.sandbox;
  if (parent === null) throw new Error("Root registry has no sandbox.");
  return {
    sandbox: {
      definition: {
        kind: "parent",
        logicalPath: "sandbox.ts",
        selector: defineParentSandbox(),
        revisionHash: "child-hash",
        sourceId: "child-sandbox",
        sourceKind: "module",
      },
      inheritance: {
        definition: parent.definition,
        nodeId: "__root__",
        workspaceResourceRoot: parent.workspaceResourceRoot,
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
}
afterEach(async () => {
  vi.useRealTimers();
  await shutdownActiveSandboxConnections();
});

describe("ensureSandboxAccess", () => {
  it("does not prepare or start anything until the sandbox is requested", async () => {
    const value = fixture();
    await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "unused",
      state: null,
    });
    expect(value.create).not.toHaveBeenCalled();
  });

  it("opens on prepare without waiting, and get waits for the work queued behind it", async () => {
    const value = fixture();
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const createNow = value.create.getMockImplementation()!;
    value.create.mockImplementationOnce(async () => {
      await gate;
      return await createNow();
    });
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "session-1",
      state: null,
    });
    const order: string[] = [];

    access.prepare();
    access.prepare(async (openSandbox) => {
      await openSandbox();
      order.push("work");
    });
    const sandbox = access.get().then((result) => {
      order.push("get");
      return result;
    });
    await vi.waitFor(() => expect(value.create).toHaveBeenCalledOnce());
    expect(order).toEqual([]);

    opened();
    await expect(sandbox).resolves.toBeTruthy();
    expect(order).toEqual(["work", "get"]);
    expect(value.start).toHaveBeenCalledOnce();
  });

  it("retries failed queued work once before later work, then drops it without failing", async () => {
    const value = fixture();
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "session-1",
      state: null,
    });
    const order: string[] = [];
    const flaky = vi
      .fn(async (_open: () => Promise<unknown>) => {
        order.push("flaky");
      })
      .mockRejectedValueOnce(new Error("disk full"));
    const broken = vi.fn(async (_open: () => Promise<unknown>) => {
      order.push("broken");
      throw new Error("disk still full");
    });

    access.prepare(flaky);
    access.prepare(broken);
    access.prepare(async () => void order.push("later"));

    await expect(access.settle()).resolves.toBeUndefined();
    await expect(access.get()).resolves.toBeTruthy();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["flaky", "broken", "broken", "later"]);
  });

  it("keeps missing production artifacts fatal without starting a sandbox", async () => {
    vi.mocked(loadSandboxPreparedArtifact).mockResolvedValueOnce(undefined);
    const value = fixture();
    const failure = open(value.registry);
    await expect(failure).rejects.toThrow(SandboxTemplateNotProvisionedError);
    await expect(failure).rejects.toThrow('agent node "__root__"');
    expect(value.create).not.toHaveBeenCalled();
  });

  it("creates and returns a real sandbox", async () => {
    const value = fixture();
    expect((await open(value.registry)).sandbox).toBeTruthy();
    expect(value.create).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session" }),
      undefined,
      null,
    );
  });
  it("resumes persisted provider state without invoking the selector", async () => {
    const setup = vi.fn();
    const value = fixture({ setup });
    await open(value.registry, "session-1", {
      session: { providerName: "test", state: null, stateProtocolVersion: 1 },
    });
    expect(setup).not.toHaveBeenCalled();
    expect(value.create).toHaveBeenCalledOnce();
  });

  it("starts a fresh sandbox when the persisted one is gone", async () => {
    const setup = vi.fn();
    const value = fixture({ idleTimeoutMs: 0, setup, stopsIdle: true });
    value.create.mockRejectedValueOnce(
      new SandboxSessionGoneError('docker session "ses_1" is no longer available to resume.'),
    );
    const { access, sandbox } = await open(value.registry, "session-1", {
      running: { idleTimeoutMs: 0, keepRunning: [{ until: Date.now() + 60_000, while: "true" }] },
      session: { providerName: "test", state: null, stateProtocolVersion: 1 },
    });
    expect(sandbox).toBeTruthy();
    expect(setup).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledOnce();
    await expect(access.captureState()).resolves.toEqual({
      running: { idleTimeoutMs: 0 },
      session: {
        generation: expect.any(String),
        providerName: "test",
        state: { key: "session-1" },
        stateProtocolVersion: 1,
      },
    });
  });

  it("starts a fresh sandbox for a session saved with the removed microsandbox provider", async () => {
    const setup = vi.fn();
    const value = fixture({ setup });
    const { access } = await open(value.registry, "session-1", {
      session: { providerName: "microsandbox", state: { key: "old" }, stateProtocolVersion: 1 },
    });
    expect(setup).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledOnce();
    await expect(access.captureState()).resolves.toEqual({
      session: {
        generation: expect.any(String),
        providerName: "test",
        state: { key: "session-1" },
        stateProtocolVersion: 1,
      },
    });
  });

  it.each([
    ["another provider", { providerName: "other", stateProtocolVersion: 1 }],
    ["another state protocol", { providerName: "test", stateProtocolVersion: 2 }],
  ])("starts a fresh sandbox for state %s recorded", async (_, record) => {
    const setup = vi.fn();
    const value = fixture({ setup });
    const { access } = await open(value.registry, "session-1", {
      session: { ...record, state: { key: "old" } },
    });
    expect(setup).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledOnce();
    await expect(access.captureState()).resolves.toEqual({
      session: {
        generation: expect.any(String),
        providerName: "test",
        state: { key: "session-1" },
        stateProtocolVersion: 1,
      },
    });
  });

  it("keeps the persisted sandbox when resume fails for another reason", async () => {
    const value = fixture();
    value.create.mockRejectedValueOnce(new Error("daemon unavailable"));
    const state = {
      session: { providerName: "test", state: { key: "old" }, stateProtocolVersion: 1 },
    };
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "session-1",
      state,
    });
    await expect(access.get()).rejects.toThrow("daemon unavailable");
    expect(value.start).not.toHaveBeenCalled();
    await expect(access.captureState()).resolves.toEqual(state);
  });

  it("starts a fresh sandbox for a session imported from eve 0.54", async () => {
    const setup = vi.fn();
    const value = fixture({ setup });
    const imported = importConversation(
      readLegacySnapshot({
        sessionId: "session-1",
        snapshot: {
          version: 1,
          session: {
            sessionId: "session-1",
            continuationToken: "http:legacy",
            history: [],
            agent: { system: "" },
            sandboxState: {
              initialized: true,
              session: {
                backendName: "test",
                metadata: { sandboxId: "sbx_old" },
                sessionKey: "old",
              },
            },
          },
        },
      }),
    );

    await open(
      value.registry,
      "session-1",
      readDurableSession(imported.sessionState).sandboxState ?? null,
    );

    expect(setup).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledOnce();
  });

  it("runs the parent's selector when a child that inherits its sandbox opens it first", async () => {
    const setup = vi.fn();
    const value = fixture({ setup });

    await open(inheritingChildRegistry(value.registry), "parent-session", null, "child");

    expect(setup).toHaveBeenCalledOnce();
    expect(value.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "parent-session" }) }),
      undefined,
      null,
    );
  });

  it("rejects a fabricated sandbox", async () => {
    const value = fixture({ returnCopy: true });
    await expect(open(value.registry)).rejects.toThrow("must return the sandbox it opens");
  });

  it("shares one selector invocation across concurrent first access", async () => {
    const value = fixture();
    const context = new ContextContainer();
    context.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn", sequence: 0 },
    });
    await contextStorage.run(context, async () => {
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry: value.registry,
        sessionId: "session-1",
        state: null,
      });
      const [first, second] = await Promise.all([access.get(), access.get()]);
      expect(second).toBe(first);
    });
    expect(value.create).toHaveBeenCalledOnce();
  });

  it("starts one sandbox when separate accesses to a shared session open concurrently", async () => {
    const value = fixture();
    const [owner, subagent] = await Promise.all([open(value.registry), open(value.registry)]);
    expect(value.start).toHaveBeenCalledOnce();
    expect(value.create).toHaveBeenCalledTimes(2);
    expect((await subagent.access.captureState()).session).toEqual(
      (await owner.access.captureState()).session,
    );
  });

  it("shares the parent's start with a subagent that inherits its sandbox", async () => {
    const value = fixture();
    const [owner, subagent] = await Promise.all([
      open(value.registry),
      open(inheritingChildRegistry(value.registry), "session-1", null, "child"),
    ]);
    expect(value.start).toHaveBeenCalledOnce();
    expect(value.create).toHaveBeenCalledTimes(2);
    expect((await subagent.access.captureState()).session).toEqual(
      (await owner.access.captureState()).session,
    );
  });

  it("lets only one waiter retry after a shared start fails", async () => {
    const value = fixture();
    value.start.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw new Error("start failed");
    });
    const results = await Promise.allSettled([
      open(value.registry),
      open(value.registry),
      open(value.registry),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(value.start).toHaveBeenCalledTimes(2);
  });

  it("retries session setup after a selector failure", async () => {
    let attempts = 0;
    const value = fixture({
      closable: true,
      setup: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("setup failed");
      },
    });
    const context = new ContextContainer();
    context.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-1",
      turn: { id: "turn", sequence: 0 },
    });
    await contextStorage.run(context, async () => {
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry: value.registry,
        sessionId: "session-1",
        state: null,
      });
      await expect(access.get()).rejects.toThrow("setup failed");
      expect(value.closeSandbox).toHaveBeenCalledOnce();
      await shutdownActiveSandboxConnections();
      expect(value.stopSandbox).not.toHaveBeenCalled();
      await expect(access.get()).resolves.toBeTruthy();
    });
    expect(attempts).toBe(2);
  });

  it("stops and closes tracked connections at server shutdown", async () => {
    const value = fixture({ closable: true });
    await open(value.registry);
    await shutdownActiveSandboxConnections();
    expect(value.stopSandbox).toHaveBeenCalledOnce();
    expect(value.closeSandbox).toHaveBeenCalledOnce();
  });

  it("closes a connection it cannot use", async () => {
    const value = fixture();
    value.create.mockImplementationOnce(async () => ({
      ...mockSandbox().connection,
      close: value.closeSandbox,
      workspaceRoot: "app",
    }));
    await expect(open(value.registry)).rejects.toThrow("workspaceRoot must be an absolute path");
    expect(value.closeSandbox).toHaveBeenCalledOnce();
  });

  it("stops a stopped sandbox without close() again at shutdown until its session ends", async () => {
    const value = fixture();
    const { access, sandbox } = await open(value.registry);
    if (sandbox === null) throw new Error("Expected a sandbox.");
    await access.stop();
    await sandbox.run({ command: "true" });
    expect(value.create).toHaveBeenCalledOnce();
    await shutdownActiveSandboxConnections();
    expect(value.stopSandbox).toHaveBeenCalledTimes(2);

    const ended = await open(value.registry, "session-2");
    await ended.access.stop();
    await ended.access.end("completed");
    await shutdownActiveSandboxConnections();
    expect(value.stopSandbox).toHaveBeenCalledTimes(3);

    const closable = fixture({ closable: true });
    await (await open(closable.registry, "session-3")).access.stop();
    await shutdownActiveSandboxConnections();
    expect(closable.stopSandbox).toHaveBeenCalledOnce();
  });

  it.each([
    ["session", false, { closed: 0, stopped: 1 }],
    ["session", true, { closed: 1, stopped: 0 }],
    ["call", false, { closed: 0, stopped: 0 }],
    ["none", true, { closed: 1, stopped: 0 }],
  ] as const)(
    "lets go of a %s access's connection (closable: %s) when its step ends",
    async (shutdownTracking, closable, expected) => {
      const value = fixture({ closable });
      const access = await ensureSandboxAccess({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        nodeId: "__root__",
        registry: value.registry,
        sessionId: "session-1",
        shutdownTracking,
        state: null,
      });
      await access.get();

      await access.release();
      await shutdownActiveSandboxConnections();

      expect(value.closeSandbox).toHaveBeenCalledTimes(expected.closed);
      expect(value.stopSandbox).toHaveBeenCalledTimes(expected.stopped);
      await access.get();
      expect(value.create).toHaveBeenCalledTimes(2);
    },
  );

  it("deletes a dedicated sandbox and creates a fresh connection on next access", async () => {
    const value = fixture();
    const { access } = await open(value.registry);
    await access.delete?.();
    await access.get();
    expect(value.onSessionEnd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "session-1" }) }),
      { key: "session-1" },
      { signal: undefined, reason: "deleted" },
    );
    expect(value.create).toHaveBeenCalledTimes(2);
  });

  it("passes terminal cleanup to the provider from durable state", async () => {
    const value = fixture();
    const { access } = await open(value.registry);

    await access.end("expired");

    expect(value.onSessionEnd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "session-1" }) }),
      { key: "session-1" },
      { reason: "expired" },
    );
    await expect(access.captureState()).resolves.toEqual({ session: null });
  });

  it("removes a sandbox a sharing child opened when the parent session ends without opening it", async () => {
    const value = upsertingFixture();
    const child = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "child",
      ownsSandbox: false,
      registry: inheritingChildRegistry(value.registry),
      sessionId: "parent-session",
      state: null,
    });
    await child.get();
    await child.end("completed");
    expect([...value.live.keys()]).toEqual(["parent-session"]);

    const parent = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "parent-session",
      state: null,
    });
    await parent.end("completed");

    expect(value.live.size).toBe(0);
  });

  it("cleans up an unrecorded key at session end without starting a sandbox", async () => {
    const value = fixture();
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry: value.registry,
      sessionId: "unused",
      state: null,
    });

    await access.end("expired");

    expect(value.onSessionEnd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ session: expect.objectContaining({ id: "unused" }) }),
      null,
      { reason: "expired" },
    );
    expect(value.start).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });

  it("does not end a sandbox borrowed from another session", async () => {
    const value = fixture();
    const { onSessionEnd } = value;
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      ownsSandbox: false,
      registry: value.registry,
      sessionId: "child",
      state: {
        session: { providerName: "test", state: null, stateProtocolVersion: 1 },
      },
    });

    await access.end?.("completed");

    expect(onSessionEnd).not.toHaveBeenCalled();
    expect(value.create).not.toHaveBeenCalled();
  });
});

describe("idle stop marker", () => {
  function unopened(
    registry: RuntimeSandboxRegistry,
    state: SandboxState | null,
    ownsSandbox?: boolean,
  ) {
    return ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      ownsSandbox,
      registry,
      sessionId: "session-1",
      state,
    });
  }

  it("records that the sandbox may be running once a step opens it, with this deployment's window", async () => {
    const value = fixture({ idleTimeoutMs: 60_000, stopsIdle: true });
    const untouched = await unopened(value.registry, null);
    await expect(untouched.captureState()).resolves.toEqual({ session: null });

    const { access } = await open(value.registry);
    const recorded = await access.captureState();
    expect(recorded).toEqual({
      running: { idleTimeoutMs: 60_000 },
      session: expect.objectContaining({ providerName: "test" }),
    });

    const later = await unopened(fixture({ idleTimeoutMs: 0, stopsIdle: true }).registry, recorded);
    await expect(later.captureState()).resolves.toEqual({
      ...recorded,
      running: { idleTimeoutMs: 0 },
    });
    for (const off of [
      fixture({ idleTimeoutMs: false, stopsIdle: true }),
      fixture({ idleTimeoutMs: 0, stopsIdle: false }),
    ]) {
      const dropped = await unopened(off.registry, recorded);
      await expect(dropped.captureState()).resolves.toEqual({ session: recorded.session });
    }
  });

  it("reads a session recorded before the marker existed as clear", async () => {
    const value = fixture({ stopsIdle: true });
    const { access } = await open(value.registry);
    const { session } = await access.captureState();

    const legacy = await unopened(value.registry, { session });
    await expect(legacy.captureState()).resolves.toEqual({ session });
  });

  it("never records the marker for a session that shares another session's sandbox", async () => {
    const value = fixture({ idleTimeoutMs: 0, stopsIdle: true });
    const owner = await open(value.registry);
    const shared = await open(
      value.registry,
      "session-1",
      await owner.access.captureState(),
      "__root__",
      false,
    );

    await expect(shared.access.captureState()).resolves.not.toHaveProperty("running");
  });

  it("clears the marker and every keepRunning() call when the session stops or deletes its sandbox", async () => {
    const value = fixture({ idleTimeoutMs: 0, stopsIdle: true });
    const stopped = await open(value.registry);
    await stopped.access.keepRunning?.({ forMs: 60_000 });
    await stopped.access.stop();
    await expect(stopped.access.captureState()).resolves.not.toHaveProperty("running");
    await stopped.access.get();
    await expect(stopped.access.captureState()).resolves.toMatchObject({
      running: { idleTimeoutMs: 0 },
    });
    await expect(stopped.access.captureState()).resolves.not.toHaveProperty("running.keepRunning");

    const deleted = await open(value.registry, "session-2");
    await deleted.access.keepRunning?.({ forMs: 60_000 });
    await deleted.access.delete?.();
    await expect(deleted.access.captureState()).resolves.toEqual({ session: null });
  });

  it("stops the recorded sandbox without opening it", async () => {
    const value = fixture({ idleTimeoutMs: 0, stopsIdle: true });
    const { access } = await open(value.registry);
    const recorded = await access.captureState();
    await access.release();
    value.start.mockClear();

    const idle = await unopened(value.registry, recorded);
    const { signal } = new AbortController();
    await expect(idle.checkRunning({ now: Date.now(), signal, stop: true })).resolves.toEqual({
      kind: "not-running",
    });

    expect(value.attach).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "session",
        session: expect.objectContaining({ id: "session-1" }),
      }),
      { key: "session-1" },
      { signal },
    );
    expect(value.stopIdleSandbox).toHaveBeenCalledExactlyOnceWith({ signal });
    expect(value.start).not.toHaveBeenCalled();
    expect(value.resume).not.toHaveBeenCalled();
  });

  it("records each keepRunning() call by its while command, and only ever moves its time later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const value = fixture({ idleTimeoutMs: 0, stopsIdle: true });
    const { access } = await open(value.registry);
    const keep = async (options: { readonly forMs: number; readonly while?: string }) =>
      (await access.keepRunning?.(options))?.until?.getTime();

    expect(await keep({ forMs: 60_000, while: "check-a" })).toBe(1_060_000);
    vi.setSystemTime(1_010_000);
    expect(await keep({ forMs: 10_000, while: "check-a" })).toBe(1_060_000);
    expect(await keep({ forMs: 120_000 })).toBe(1_130_000);
    vi.setSystemTime(1_020_000);
    expect(await keep({ forMs: 60_000, while: "check-a" })).toBe(1_080_000);

    await expect(access.captureState()).resolves.toMatchObject({
      running: {
        idleTimeoutMs: 0,
        keepRunning: [
          { until: 1_080_000, while: "check-a" },
          { until: 1_130_000, while: "true" },
        ],
      },
    });
    expect(value.attach).not.toHaveBeenCalled();
    expect(value.stopIdleSandbox).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the idle stop is off", options: { idleTimeoutMs: false as const, stopsIdle: true } },
    {
      name: "another session owns the sandbox",
      options: { idleTimeoutMs: 0, stopsIdle: true },
      shared: true,
    },
    { name: "the provider has no attach()", options: { idleTimeoutMs: 0, stopsIdle: false } },
    {
      name: "the sandbox was stopped in this step",
      options: { idleTimeoutMs: 0, stopsIdle: true },
      stopped: true,
    },
  ])(
    "keeps nothing running and resolves { until: null } when $name",
    async ({ options, shared, stopped }) => {
      const value = fixture(options);
      const owner = await open(value.registry);
      const { access } =
        shared === true
          ? await open(
              value.registry,
              "session-1",
              await owner.access.captureState(),
              "__root__",
              false,
            )
          : owner;
      if (stopped === true) await access.stop();

      await expect(access.keepRunning?.({ forMs: 60_000, while: "true" })).resolves.toEqual({
        until: null,
      });
      await expect(access.captureState()).resolves.not.toHaveProperty("running.keepRunning");
    },
  );

  it.each([
    {
      name: "a forMs of 0",
      call: { forMs: 0 },
      message:
        "sandbox.keepRunning() received forMs 0. Pass a number of milliseconds greater than 0 and at most 86400000 (24 hours), and call keepRunning() again to extend.",
    },
    { name: "a negative forMs", call: { forMs: -1 }, message: "received forMs -1." },
    {
      name: "an infinite forMs",
      call: { forMs: Number.POSITIVE_INFINITY },
      message: "received forMs Infinity.",
    },
    {
      name: "a forMs that is a string",
      call: { forMs: "60000" as never },
      message: "received forMs 60000.",
    },
    {
      name: "a forMs above 24 hours",
      call: { forMs: 86_400_001 },
      message: "received forMs 86400001.",
    },
    {
      name: "an empty while",
      call: { forMs: 60_000, while: "" },
      message:
        "sandbox.keepRunning() received a `while` command of 0 characters. Pass a shell command of 1 to 1,000 characters, such as one that runs a script in the sandbox.",
    },
    {
      name: "an over-long while",
      call: { forMs: 60_000, while: "x".repeat(1_001) },
      message: "received a `while` command of 1001 characters.",
    },
    {
      name: "a while that is not a string",
      call: { forMs: 60_000, while: 1 as never },
      message: "received a `while` command that is not a string.",
    },
  ])(
    "rejects $name, with what to pass instead, even where the call has no effect",
    async ({ call, message }) => {
      const { access } = await open(fixture({ stopsIdle: false }).registry);

      await expect(access.keepRunning?.(call)).rejects.toThrow(message);
    },
  );

  it("rejects a ninth different while command, and still extends one of the eight", async () => {
    const { access } = await open(fixture({ idleTimeoutMs: 0, stopsIdle: true }).registry);
    for (let index = 0; index < 8; index += 1)
      await access.keepRunning?.({ forMs: 60_000, while: `check-${index}` });

    await expect(access.keepRunning?.({ forMs: 60_000, while: "check-8" })).rejects.toThrow(
      "This sandbox is already kept running under 8 different `while` commands. Pass one of them again to extend it, or wait until one ends.",
    );
    await expect(access.keepRunning?.({ forMs: 120_000, while: "check-0" })).resolves.toEqual({
      until: expect.any(Date),
    });
  });

  const until = 2_000_000;
  const exits = (exitCode: number) => () => ({ exitCode, stderr: "", stdout: "" });
  it.each([
    {
      name: "its check passes",
      check: exits(0),
      now: 1_000_000,
      stop: true,
      expected: { kind: "running", keepRunning: [{ until, while: "check-a" }] },
      stops: false,
    },
    {
      name: "its check exits non-zero",
      check: exits(1),
      now: 1_000_000,
      stop: true,
      expected: { kind: "not-running" },
      stops: true,
    },
    {
      name: "its time is up while its check passes",
      check: exits(0),
      now: until,
      stop: true,
      expected: { kind: "not-running" },
      stops: true,
    },
    {
      name: "its check cannot run",
      check: () => {
        throw new Error("The sandbox is not reachable.");
      },
      now: 1_000_000,
      stop: true,
      expected: { kind: "running", keepRunning: [{ until, while: "check-a" }] },
      stops: false,
    },
    {
      name: "its check does not exit within 10 seconds",
      check: () => new Promise<never>(() => {}),
      now: 1_000_000,
      stop: true,
      expected: { kind: "running", keepRunning: [{ until, while: "check-a" }] },
      stops: false,
    },
    {
      name: "nothing is in effect during a turn",
      check: exits(1),
      now: 1_000_000,
      stop: false,
      expected: { kind: "running", keepRunning: [] },
      stops: false,
    },
    {
      name: "the stop fails",
      check: exits(1),
      now: 1_000_000,
      stop: true,
      stopFails: true,
      expected: { kind: "stop-failed", error: new Error("docker stop failed") },
      stops: true,
    },
  ])(
    "checks the sandbox a keepRunning() call keeps running when $name",
    async ({ check, expected, now, stop, stopFails, stops }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const value = fixture({ check, idleTimeoutMs: 0, stopsIdle: true });
      if (stopFails === true)
        value.stopIdleSandbox.mockRejectedValueOnce(new Error("docker stop failed"));
      const access = await unopened(value.registry, {
        running: { idleTimeoutMs: 0, keepRunning: [{ until, while: "check-a" }] },
        session: { providerName: "test", state: { key: "session-1" }, stateProtocolVersion: 1 },
      });

      const checked = access.checkRunning({ now, signal: new AbortController().signal, stop });
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(checked).resolves.toEqual(expected);
      expect(value.stopIdleSandbox).toHaveBeenCalledTimes(stops ? 1 : 0);
      expect(value.closeAttached).toHaveBeenCalledOnce();
      expect(value.resume).not.toHaveBeenCalled();
    },
  );

  it("keeps keepRunning() calls, and drops a stale field, when a cancelled or interrupted step marks the sandbox as running", () => {
    const keepRunning = [{ until: 4_660_000, while: "true" }];
    const running = { backgroundUntil: 4_660_000, idleTimeoutMs: 0, keepRunning };

    expect(
      markSandboxRunning({ sandboxState: { running, session: null } }, 60_000).sandboxState.running,
    ).toStrictEqual({ idleTimeoutMs: 60_000, keepRunning });
  });

  it("leaves the sandbox alone when this deployment turned the idle stop off", async () => {
    const value = fixture({ idleTimeoutMs: false, stopsIdle: true });
    const recorded = { running: { idleTimeoutMs: 0 }, session: null };

    await expect(
      (await unopened(value.registry, recorded)).checkRunning({
        now: Date.now(),
        signal: new AbortController().signal,
        stop: true,
      }),
    ).resolves.toEqual({ kind: "not-running" });

    expect(value.attach).not.toHaveBeenCalled();
  });
});
