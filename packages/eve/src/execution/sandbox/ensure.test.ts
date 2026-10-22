import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdownActiveSandboxConnections } from "#execution/sandbox/active-connections.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { importConversation, readLegacySnapshot } from "#execution/legacy-session/snapshot.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineParentSandbox, defineSandbox } from "#public/definitions/sandbox.js";
import { defineSandboxProvider, type SandboxSessionContext } from "#sandbox/provider.js";
import { SandboxSessionGoneError } from "#shared/sandbox-session-gone-error.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

function fixture(
  options: {
    readonly closable?: boolean;
    readonly returnCopy?: boolean;
    readonly setup?: () => void;
  } = {},
) {
  const { returnCopy = false, setup } = options;
  const onSessionEnd = vi.fn(async () => {});
  const stopSandbox = vi.fn(async () => {});
  const closeSandbox = vi.fn(async () => {});
  const create = vi.fn(async () => {
    const { connection } = mockSandbox({ stop: stopSandbox });
    return options.closable === true ? { ...connection, close: closeSandbox } : connection;
  });
  const start = vi.fn(async (context: SandboxSessionContext) => ({
    connection: await create(),
    state: { key: context.session.id },
  }));
  const provider = defineSandboxProvider({
    name: "test",
    environment: () => ({ onSessionEnd, prepare: async () => null, start, resume: create }),
  });
  const environment = provider.environment();
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
  return { closeSandbox, create, onSessionEnd, registry, start, stopSandbox };
}
/** A provider that honors the contract: `start` upserts on the session id, and cleanup deletes by it. */
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
afterEach(() => shutdownActiveSandboxConnections());

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

  // https://github.com/vercel/eve/issues/5113
  it("starts a fresh sandbox when the persisted one is gone", async () => {
    const setup = vi.fn();
    const value = fixture({ setup });
    value.create.mockRejectedValueOnce(
      new SandboxSessionGoneError('docker session "ses_1" is no longer available to resume.'),
    );
    const { access, sandbox } = await open(value.registry, "session-1", {
      session: { providerName: "test", state: null, stateProtocolVersion: 1 },
    });
    expect(sandbox).toBeTruthy();
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
            // eve 0.54 persisted a backend reconnect record, not provider state.
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
      // The rejected connection is closed and left out of shutdown tracking.
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
    // A resumed connection is still running, so shutdown stops it again.
    await sandbox.run({ command: "true" });
    expect(value.create).toHaveBeenCalledOnce();
    await shutdownActiveSandboxConnections();
    expect(value.stopSandbox).toHaveBeenCalledTimes(2);

    const ended = await open(value.registry, "session-2");
    await ended.access.stop();
    await ended.access.end("completed");
    await shutdownActiveSandboxConnections();
    expect(value.stopSandbox).toHaveBeenCalledTimes(3);

    // A connection with close() is closed by stop() and cannot resume.
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
      // Only a connection without close() stays for shutdown, and only a session's own.
      await shutdownActiveSandboxConnections();

      expect(value.closeSandbox).toHaveBeenCalledTimes(expected.closed);
      expect(value.stopSandbox).toHaveBeenCalledTimes(expected.stopped);
      // The next use in the session opens a new connection.
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
      { abortSignal: undefined, reason: "deleted" },
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

    // The parent never opened the sandbox and has no checkpointed provider state.
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
