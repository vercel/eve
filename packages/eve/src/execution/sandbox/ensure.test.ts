import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveSandboxHandlesForTest,
  countActiveSandboxHandles,
} from "#execution/sandbox/active-handles.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";

function fixture(
  shared = false,
  setup?: () => void,
  returnCopy = false,
  sharedNameFromPrincipal = false,
) {
  const deleteSandbox = vi.fn(async () => {});
  const stopSandbox = vi.fn(async () => {});
  const create = vi.fn(async (context) => {
    const sandbox = mockSandbox({ id: context.sandboxName });
    return context.handle({
      delete: deleteSandbox,
      metadata: {},
      sandbox: sandbox.session,
      shutdown: async () => {},
      stop: stopSandbox,
    });
  });
  const provider = defineSandboxProvider({
    name: "test",
    environment: () => ({
      getOrCreate: create,
      prepare: async () => ({ artifact: {}, reused: true }),
    }),
  });
  const environment = provider.environment();
  const selector = defineSandbox(async ({ session }) => {
    const sandbox = shared
      ? await environment.getOrCreate({
          name: sharedNameFromPrincipal
            ? `principal-${session.auth.current?.principalId ?? "anonymous"}`
            : "team-acme",
        })
      : await environment.create();
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
        sourceHash: "hash",
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
  it("creates and returns a real sandbox", async () => {
    const value = fixture();
    expect((await open(value.registry)).sandbox?.id).toContain("session-1");
    expect(value.create).toHaveBeenCalledOnce();
  });
  it("uses an authored shared name and protects its provider-owned lifetime", async () => {
    const value = fixture(true);
    const { access } = await open(value.registry);
    expect(value.create.mock.calls[0]?.[0].sandboxName).toContain("team-acme");
    await expect(access.delete?.()).rejects.toThrow("provider-owned lifetime");
    await expect(access.stop()).rejects.toThrow("cannot be stopped");
    expect(value.deleteSandbox).not.toHaveBeenCalled();
    expect(value.stopSandbox).not.toHaveBeenCalled();
  });

  it("rejects a fabricated sandbox even when its id matches", async () => {
    const value = fixture(false, undefined, true);
    await expect(open(value.registry)).rejects.toThrow("must return the sandbox it creates");
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
      expect(second?.id).toBe(first?.id);
    });
    expect(value.create).toHaveBeenCalledOnce();
  });

  it("retries session setup after a selector failure", async () => {
    let attempts = 0;
    const value = fixture(false, () => {
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

  it("does not reattach persisted shared sandbox metadata when the derived name changes", async () => {
    const value = fixture(true, undefined, false, true);
    const first = await open(value.registry, "durable-session", null, "principal-a");
    const state = await first.access.captureState();
    const firstCreate = value.create.mock.calls[0]?.[0];
    value.create.mockClear();

    await open(value.registry, "durable-session", state, "principal-b");

    const secondCreate = value.create.mock.calls[0]?.[0];
    expect(secondCreate?.sandboxName).not.toBe(firstCreate?.sandboxName);
    expect(secondCreate?.existing).toBeUndefined();
  });
});
