import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveSandboxHandlesForTest,
  countActiveSandboxHandles,
} from "#execution/sandbox/active-handles.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineParentSandbox, defineSandbox } from "#public/definitions/sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { loadSandboxPreparedArtifact } from "#runtime/sandbox/prepared-artifacts.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => null),
}));

function fixture(setup?: () => void, returnCopy = false) {
  const deleteSandbox = vi.fn(async () => {});
  const stopSandbox = vi.fn(async () => {});
  const create = vi.fn(async () => {
    const sandbox = mockSandbox();
    return {
      sandbox: sandbox.session,
      onSessionDelete: deleteSandbox,
      onRuntimeShutdown: async () => {},
      onSessionStop: stopSandbox,
    };
  });
  const provider = defineSandboxProvider({
    name: "test",
    environment: () => ({
      prepare: async () => null,
      resume: create,
      start: async () => ({ handle: await create(), state: null }),
    }),
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
  return { create, deleteSandbox, registry, stopSandbox };
}
async function open(
  registry: RuntimeSandboxRegistry,
  id = "session-1",
  state: Parameters<typeof ensureSandboxAccess>[0]["state"] = null,
  principalId?: string,
) {
  const context = new ContextContainer();
  const auth =
    principalId === undefined
      ? null
      : {
          attributes: {},
          authenticator: "test",
          principalId,
          principalType: "user",
        };
  context.set(SessionKey, {
    auth: { current: auth, initiator: auth },
    sessionId: id,
    turn: { id: "turn", sequence: 0 },
  });
  return await contextStorage.run(context, async () => {
    const access = await ensureSandboxAccess({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      nodeId: "__root__",
      registry,
      sessionId: id,
      state,
    });
    return { access, sandbox: await access.get() };
  });
}
afterEach(() => clearActiveSandboxHandlesForTest());

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
    await expect(open(value.registry)).rejects.toThrow();
    expect(value.create).not.toHaveBeenCalled();
  });

  it("creates and returns a real sandbox", async () => {
    const value = fixture();
    expect((await open(value.registry)).sandbox).toBeTruthy();
    expect(value.create).toHaveBeenCalledOnce();
  });
  it("resumes persisted provider state without invoking the selector", async () => {
    const setup = vi.fn();
    const value = fixture(setup);
    await open(value.registry, "session-1", {
      session: { providerName: "test", state: null, stateProtocolVersion: 1 },
    });
    expect(setup).not.toHaveBeenCalled();
    expect(value.create).toHaveBeenCalledOnce();
  });

  it("passes empty live options when a child inherits its parent sandbox", async () => {
    const value = fixture();
    const parent = value.registry.sandbox;
    const registry: RuntimeSandboxRegistry = {
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

    await open(registry);

    expect(value.create).toHaveBeenCalledOnce();
  });

  it("rejects a fabricated sandbox", async () => {
    const value = fixture(undefined, true);
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

  it("retries session setup after a selector failure", async () => {
    let attempts = 0;
    const value = fixture(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("setup failed");
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
      expect(countActiveSandboxHandles()).toBe(0);
      await expect(access.get()).resolves.toBeTruthy();
    });
    expect(attempts).toBe(2);
  });

  it("tracks dedicated handles for server shutdown", async () => {
    const value = fixture();
    await open(value.registry);
    expect(countActiveSandboxHandles()).toBe(1);
  });

  it("deletes a dedicated sandbox and creates a fresh handle on next access", async () => {
    const value = fixture();
    const { access } = await open(value.registry);
    await access.delete?.();
    await access.get();
    expect(value.deleteSandbox).toHaveBeenCalledOnce();
    expect(value.create).toHaveBeenCalledTimes(2);
  });
});
