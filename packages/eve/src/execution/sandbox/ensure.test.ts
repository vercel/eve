import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  clearActiveSandboxHandlesForTest,
  countActiveSandboxHandles,
  shutdownActiveSandboxHandles,
} from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import type { PrewarmedSandboxTemplateBinding } from "#execution/sandbox/prewarm.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxDefinitionContext } from "#public/definitions/sandbox.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";
import type { SandboxState, SandboxStateValue } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";
import {
  defineSandboxTemplate,
  getSandboxTemplateInternal,
  type SandboxTemplate,
} from "#shared/sandbox-template.js";
import type { SandboxTemplatePrewarmLockInput } from "#execution/sandbox/template-prewarm-lock.js";
import {
  defineSandboxAdapter,
  type Sandbox,
  type SandboxProviderContext,
} from "#shared/sandbox-value.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const mocks = vi.hoisted(() => ({
  prewarmAppSandboxes: vi.fn<() => Promise<readonly PrewarmedSandboxTemplateBinding[]>>(
    async () => [],
  ),
  waitForSandboxTemplatePrewarmLock: vi.fn(async (_input: SandboxTemplatePrewarmLockInput) => {}),
  waitForDevelopmentSandboxPrewarm: vi.fn<
    () => Promise<readonly PrewarmedSandboxTemplateBinding[]>
  >(async () => []),
}));

vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  waitForDevelopmentSandboxPrewarm: mocks.waitForDevelopmentSandboxPrewarm,
}));
vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmAppSandboxes: mocks.prewarmAppSandboxes,
}));
vi.mock("#execution/sandbox/template-prewarm-lock.js", () => ({
  waitForSandboxTemplatePrewarmLock: mocks.waitForSandboxTemplatePrewarmLock,
}));

interface TestSandboxReference extends JsonObject {
  readonly id: string;
}

interface TestSandboxHandle {
  readonly id: string;
  readonly session: SandboxSession;
}

const testSandboxes = new Map<string, TestSandboxHandle>();
const restoreTestSandboxContexts: SandboxProviderContext[] = [];
const restoreTestSandbox = vi.fn((reference: TestSandboxReference) => {
  const handle = testSandboxes.get(reference.id);
  if (handle === undefined) {
    throw new Error(`Missing test sandbox "${reference.id}".`);
  }
  return handle;
});
const shutdownTestSandbox = vi.fn();
const asTestSandbox = defineSandboxAdapter<TestSandboxHandle, TestSandboxReference>({
  type: "eve/test-sandbox",
  reference(handle) {
    return { id: handle.id };
  },
  restore(reference, context) {
    restoreTestSandboxContexts.push(context);
    return restoreTestSandbox(reference);
  },
  session(handle) {
    return handle.session;
  },
  shutdown(handle) {
    shutdownTestSandbox(handle.id);
  },
});
const asOtherTestSandbox = defineSandboxAdapter<TestSandboxHandle, TestSandboxReference>({
  type: "eve/other-test-sandbox",
  reference(handle) {
    return { id: handle.id };
  },
  restore(reference, context) {
    restoreTestSandboxContexts.push(context);
    return restoreTestSandbox(reference);
  },
  session(handle) {
    return handle.session;
  },
  shutdown(handle) {
    shutdownTestSandbox(handle.id);
  },
});

function createTestSandbox(id: string): Sandbox {
  const handle = {
    id,
    session: mockSandbox({ id }).session,
  };
  testSandboxes.set(id, handle);
  return asTestSandbox(handle);
}

function createOtherTestSandbox(id: string): Sandbox {
  const handle = {
    id,
    session: mockSandbox({ id }).session,
  };
  testSandboxes.set(id, handle);
  return asOtherTestSandbox(handle);
}

function createTestRegistry(input: {
  readonly definition: RuntimeSandboxRegistry["sandbox"]["definition"]["definition"];
  readonly sourceHash?: string;
  readonly templates?: ReadonlyArray<{
    readonly exportName: string;
    readonly reference?: unknown;
    readonly template: SandboxTemplate;
  }>;
  readonly workspaceResourceRoot?: RuntimeSandboxRegistry["sandbox"]["workspaceResourceRoot"];
}): RuntimeSandboxRegistry {
  return {
    sandbox: {
      definition: {
        definition: input.definition,
        logicalPath: "agent/sandbox/sandbox.ts",
        sourceHash: input.sourceHash ?? "test-source-hash",
        sourceId: "agent/sandbox/sandbox",
        sourceKind: "module",
        templates: input.templates ?? [],
      },
      workspaceResourceRoot: input.workspaceResourceRoot ?? { logicalPath: "", rootEntries: [] },
    },
  };
}

async function ensure(input: {
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
  readonly parentState?: SandboxStateValue;
  readonly registry: RuntimeSandboxRegistry;
  readonly rootState?: SandboxStateValue;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly state?: SandboxState | null;
  readonly tags?: Readonly<Record<string, string>>;
}) {
  const sessionId = input.sessionId ?? "session_1";
  const context = new ContextContainer();
  const access = await ensureSandboxAccess({
    compiledArtifactsSource:
      input.compiledArtifactsSource ?? createBundledRuntimeCompiledArtifactsSource(),
    context,
    nodeId: input.nodeId ?? "__root__",
    parentState: input.parentState,
    registry: input.registry,
    rootState: input.rootState,
    signal: input.signal,
    session: createSession(sessionId),
    sessionId,
    state: input.state ?? null,
    tags: input.tags,
  });
  return {
    async captureState() {
      return await contextStorage.run(context, async () => await access.captureState());
    },
    async get() {
      return await contextStorage.run(context, async () => await access.get());
    },
  };
}

function createSession(sessionId: string): SandboxDefinitionContext["session"] {
  return {
    auth: {
      current: {
        attributes: { teamId: "team_1" },
        authenticator: "test",
        issuer: "test",
        principalId: "user_1",
        principalType: "user",
      },
      initiator: null,
    },
    id: sessionId,
    turn: { id: "turn_1", sequence: 0 },
  };
}

describe("ensureSandboxAccess", () => {
  beforeEach(() => {
    clearActiveSandboxHandlesForTest();
    testSandboxes.clear();
    restoreTestSandboxContexts.length = 0;
    restoreTestSandbox.mockClear();
    shutdownTestSandbox.mockClear();
    mocks.prewarmAppSandboxes.mockClear();
    mocks.waitForDevelopmentSandboxPrewarm.mockClear();
    mocks.waitForSandboxTemplatePrewarmLock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("invokes the definition lazily with session and runtime context", async () => {
    const signal = new AbortController().signal;
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const access = await ensure({
      registry: createTestRegistry({ definition }),
      signal,
    });

    expect(definition).not.toHaveBeenCalled();
    expect(await access.captureState()).toBeNull();

    await expect(access.get()).resolves.toMatchObject({ id: "sandbox_1" });
    expect(definition).toHaveBeenCalledWith({
      parent: null,
      root: null,
      runtime: { mode: expect.stringMatching(/^(development|production)$/) },
      session: expect.objectContaining({
        auth: expect.objectContaining({
          current: expect.objectContaining({ principalId: "user_1" }),
        }),
        id: "session_1",
      }),
      signal,
    });
  });

  it("restores persisted provider state without invoking the definition again", async () => {
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const registry = createTestRegistry({ definition });
    const first = await ensure({ registry });

    await first.get();
    const state = await first.captureState();
    expect(state).not.toBeNull();
    expect(state?.value).toMatchObject({
      id: "sandbox_1",
      reference: { id: "sandbox_1" },
      resourceId: expect.any(String),
    });

    const second = await ensure({ registry, state });
    const restored = await second.get();
    await restored?.run({ command: "true" });

    expect(definition).toHaveBeenCalledTimes(1);
    expect(restoreTestSandbox).toHaveBeenCalledWith({ id: "sandbox_1" });
  });

  it("captures restored state without reconnecting when the sandbox went unused", async () => {
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const registry = createTestRegistry({ definition });
    const first = await ensure({ registry });
    await first.get();
    const state = await first.captureState();
    restoreTestSandbox.mockClear();

    const second = await ensure({ registry, state });
    await second.get();
    const recaptured = await second.captureState();

    expect(recaptured?.value).toEqual(state?.value);
    expect(restoreTestSandbox).not.toHaveBeenCalled();
  });

  it("reserializes a restored sandbox once an operation has used it", async () => {
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const registry = createTestRegistry({ definition });
    const first = await ensure({ registry });
    await first.get();
    const state = await first.captureState();
    restoreTestSandbox.mockClear();

    const second = await ensure({ registry, state });
    const restored = await second.get();
    await restored?.run({ command: "true" });
    const recaptured = await second.captureState();

    expect(recaptured?.value).toEqual(state?.value);
    expect(restoreTestSandbox).toHaveBeenCalledTimes(1);
  });

  it("invokes the definition again when its private compatibility revision changes", async () => {
    const firstDefinition = vi.fn(() => createTestSandbox("sandbox_1"));
    const first = await ensure({
      registry: createTestRegistry({
        definition: firstDefinition,
        sourceHash: "source-v1",
      }),
    });
    await first.get();
    const state = await first.captureState();

    const secondDefinition = vi.fn(() => createTestSandbox("sandbox_2"));
    const second = await ensure({
      registry: createTestRegistry({
        definition: secondDefinition,
        sourceHash: "source-v2",
      }),
      state,
    });

    await expect(second.get()).resolves.toMatchObject({ id: "sandbox_2" });
    expect(secondDefinition).toHaveBeenCalledTimes(1);
    expect(restoreTestSandbox).not.toHaveBeenCalled();
  });

  it("tracks different providers separately when their sandbox ids match", async () => {
    const first = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("shared-provider-id"),
      }),
      sessionId: "first-session",
    });
    const second = await ensure({
      registry: createTestRegistry({
        definition: () => createOtherTestSandbox("shared-provider-id"),
      }),
      sessionId: "second-session",
    });

    await Promise.all([first.get(), second.get()]);

    expect(countActiveSandboxHandles()).toBe(2);
  });

  it("tracks distinct durable resources when one provider exposes the same sandbox id", async () => {
    const first = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("shared-session-id"),
      }),
      sessionId: "first-session",
    });
    const second = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("shared-session-id"),
      }),
      sessionId: "second-session",
    });

    await Promise.all([first.get(), second.get()]);

    expect(countActiveSandboxHandles()).toBe(2);
  });

  it("rejects a managed workspace whose definition exports no template", async () => {
    const definition = vi.fn(() => createTestSandbox("sandbox_1"));
    const access = await ensure({
      registry: createTestRegistry({
        definition,
        workspaceResourceRoot: {
          contentHash: "workspace-hash",
          logicalPath: "agent/sandbox/workspace",
          rootEntries: ["package.json"],
        },
      }),
    });

    await expect(access.get()).rejects.toThrow(
      /has a managed workspace but exports no SandboxTemplate/,
    );
    expect(definition).not.toHaveBeenCalled();
  });

  it("rejects a transient provider handle returned from outside the authored invocation", async () => {
    const transient = createTestSandbox("transient-sandbox");
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => transient,
      }),
    });

    await expect(access.get()).rejects.toThrow(/Cannot persist transient sandbox/);
    expect(countActiveSandboxHandles()).toBe(0);
  });

  it("exposes durable parent and root sandboxes and preserves the exact provider reference", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();
    expect(rootState).not.toBeNull();
    clearActiveSandboxHandlesForTest();

    const childDefinition = vi.fn(async ({ parent, root: rootAncestor }) => {
      const parentSandbox = await parent!.sandbox;
      const rootSandbox = await rootAncestor!.sandbox;
      expect(parentSandbox).toBe(rootSandbox);
      return parentSandbox;
    });
    const child = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({ definition: childDefinition }),
      rootState: rootState!,
      sessionId: "child-session",
      tags: { agent: "child" },
    });

    await expect(child.get()).resolves.toMatchObject({ id: "root-sandbox" });
    const childState = await child.captureState();
    expect(childState).toMatchObject({
      root: rootState,
    });
    expect(childState?.value).toEqual(rootState?.value);
    expect(countActiveSandboxHandles()).toBe(0);
    expect(restoreTestSandboxContexts).toHaveLength(0);
  });

  it("reserializes a returned ancestor once the definition has used it", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();
    clearActiveSandboxHandlesForTest();

    const child = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({
        async definition({ parent }) {
          const sandbox = await parent!.sandbox;
          await sandbox.run({ command: "true" });
          return sandbox;
        },
      }),
      rootState: rootState!,
      sessionId: "child-session",
      tags: { agent: "child" },
    });

    await child.get();
    const childState = await child.captureState();
    expect(childState?.value.resourceId).toBe(rootState?.value.resourceId);
    expect(countActiveSandboxHandles()).toBe(1);
    expect(restoreTestSandboxContexts).toHaveLength(1);
    expect(restoreTestSandboxContexts[0]).toMatchObject({
      resourceId: rootState?.value.resourceId,
      tags: undefined,
    });
  });

  it("does not reconnect unused ancestor sandboxes", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();
    clearActiveSandboxHandlesForTest();
    restoreTestSandbox.mockClear();

    const child = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({
        definition: () => createTestSandbox("child-sandbox"),
      }),
      rootState: rootState!,
      sessionId: "child-session",
    });

    await expect(child.get()).resolves.toMatchObject({ id: "child-sandbox" });
    await Promise.resolve();
    expect(restoreTestSandbox).not.toHaveBeenCalled();
    expect(countActiveSandboxHandles()).toBe(1);
  });

  it("tracks an ancestor sandbox when the definition uses it but returns another resource", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();
    clearActiveSandboxHandlesForTest();

    const child = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({
        async definition({ parent }) {
          await (await parent!.sandbox).run({ command: "true" });
          return createTestSandbox("child-sandbox");
        },
      }),
      rootState: rootState!,
      sessionId: "child-session",
    });

    await child.get();
    expect(countActiveSandboxHandles()).toBe(2);
  });

  it("keeps the original root sandbox distinct through nested children", async () => {
    const root = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("root-sandbox"),
      }),
      sessionId: "root-session",
    });
    await root.get();
    const rootState = await root.captureState();

    const parent = await ensure({
      nodeId: "reviewer",
      parentState: rootState!,
      registry: createTestRegistry({
        definition: () => createTestSandbox("reviewer-sandbox"),
      }),
      rootState: rootState!,
      sessionId: "reviewer-session",
    });
    await parent.get();
    const parentState = await parent.captureState();

    const grandchildDefinition = vi.fn(async ({ parent, root: rootAncestor }) => {
      expect((await parent?.sandbox)?.id).toBe("reviewer-sandbox");
      expect((await rootAncestor?.sandbox)?.id).toBe("root-sandbox");
      return await rootAncestor!.sandbox;
    });
    const grandchild = await ensure({
      nodeId: "reviewer/writer",
      parentState: parentState!,
      registry: createTestRegistry({ definition: grandchildDefinition }),
      rootState: parentState!.root,
      sessionId: "writer-session",
    });

    await expect(grandchild.get()).resolves.toMatchObject({ id: "root-sandbox" });
    expect(await grandchild.captureState()).toMatchObject({
      root: rootState,
    });
    expect(countActiveSandboxHandles()).toBe(2);
  });

  it("binds the exact compiled template reference before invoking the definition", async () => {
    const create = vi.fn(({ reference }: { reference: { snapshotId: string } }) =>
      createTestSandbox(reference.snapshotId),
    );
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      type: "test.dev/compiled-template/v1",
      async prewarm() {
        return { snapshotId: "prewarmed" };
      },
      create,
    });
    const registry = createTestRegistry({
      definition: () => template.create({}),
      templates: [
        {
          exportName: "template",
          reference: { snapshotId: "snapshot_123" },
          template,
        },
      ],
    });

    const access = await ensure({ registry });
    await expect(access.get()).resolves.toMatchObject({ id: "snapshot_123" });
    expect(create).toHaveBeenCalledWith({
      options: {},
      reference: { snapshotId: "snapshot_123" },
    });
  });

  it("never fabricates a provider reference for an unbound production template", async () => {
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      type: "test.dev/unbound-template/v1",
      async prewarm() {
        return { snapshotId: "build-only" };
      },
      create({ reference }) {
        return createTestSandbox(reference.snapshotId);
      },
    });
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => template.create({}),
        templates: [{ exportName: "template", template }],
      }),
    });

    await expect(access.get()).rejects.toThrow(/no prewarmed build result/);
  });

  it("binds the exact reference produced by development prewarming before creation", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      type: "test.dev/development-template/v1",
      async prewarm() {
        return { snapshotId: "development-snapshot" };
      },
      create({ reference }) {
        return createTestSandbox(reference.snapshotId);
      },
    });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(process.cwd());
    const registry = createTestRegistry({
      definition: () => template.create({}),
      templates: [{ exportName: "template", template }],
    });
    const templateKey = await createTestTemplateKey({
      compiledArtifactsSource,
      registry,
      template,
    });
    mocks.waitForDevelopmentSandboxPrewarm.mockResolvedValueOnce([
      {
        exportName: "template",
        nodeId: "__root__",
        reference: { snapshotId: "development-snapshot" },
        templateKey,
      },
    ]);
    const access = await ensure({
      compiledArtifactsSource,
      registry,
    });

    await expect(access.get()).resolves.toMatchObject({ id: "development-snapshot" });
    expect(mocks.prewarmAppSandboxes).not.toHaveBeenCalled();
  });

  it("prewarms the current development template when a previous generation resolves", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      type: "test.dev/rebuilt-template/v1",
      async prewarm() {
        return { snapshotId: "current-snapshot" };
      },
      create({ reference }) {
        return createTestSandbox(reference.snapshotId);
      },
    });
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(process.cwd());
    const registry = createTestRegistry({
      definition: () => template.create({}),
      sourceHash: "current-source-hash",
      templates: [{ exportName: "template", template }],
    });
    const templateKey = await createTestTemplateKey({
      compiledArtifactsSource,
      registry,
      template,
    });
    mocks.waitForDevelopmentSandboxPrewarm.mockResolvedValueOnce([
      {
        exportName: "template",
        nodeId: "__root__",
        reference: { snapshotId: "stale-snapshot" },
        templateKey: "previous-generation-template-key",
      },
    ]);
    mocks.prewarmAppSandboxes.mockResolvedValueOnce([
      {
        exportName: "template",
        nodeId: "__root__",
        reference: { snapshotId: "current-snapshot" },
        templateKey,
      },
    ]);

    const access = await ensure({ compiledArtifactsSource, registry });

    await expect(access.get()).resolves.toMatchObject({ id: "current-snapshot" });
    expect(mocks.prewarmAppSandboxes).toHaveBeenCalledOnce();
  });

  it("waits for development prewarm before invoking a templated definition", async () => {
    const waiting = createDeferred<readonly PrewarmedSandboxTemplateBinding[]>();
    mocks.waitForDevelopmentSandboxPrewarm.mockReturnValueOnce(waiting.promise);
    const template = defineSandboxTemplate<{ snapshotId: string }, Record<string, never>>({
      type: "test.dev/waiting-template/v1",
      async prewarm() {
        return { snapshotId: "snapshot_1" };
      },
      create() {
        return createTestSandbox("sandbox_1");
      },
    });
    const definition = vi.fn(() => template.create({}));
    const appRoot = process.cwd();
    const access = await ensure({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      registry: createTestRegistry({
        definition,
        templates: [
          {
            exportName: "template",
            reference: { snapshotId: "snapshot_1" },
            template,
          },
        ],
      }),
    });

    const sandbox = access.get();
    await vi.waitFor(() => {
      expect(mocks.waitForDevelopmentSandboxPrewarm).toHaveBeenCalled();
    });
    expect(definition).not.toHaveBeenCalled();

    waiting.resolve([]);
    await sandbox;
    expect(definition).toHaveBeenCalledTimes(1);
  });

  it("rejects definitions that return an ordinary session instead of a durable sandbox", async () => {
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => mockSandbox().session as Sandbox,
      }),
    });

    await expect(access.get()).rejects.toThrow(/must return a durable Sandbox value/);
  });

  it("tracks custom provider sandboxes for process shutdown", async () => {
    const access = await ensure({
      registry: createTestRegistry({
        definition: () => createTestSandbox("custom-sandbox"),
      }),
    });

    await access.get();
    expect(countActiveSandboxHandles()).toBe(1);

    await shutdownActiveSandboxHandles();
    expect(shutdownTestSandbox).toHaveBeenCalledWith("custom-sandbox");
  });

  it("tracks provider sandboxes before authored setup rejects", async () => {
    const access = await ensure({
      registry: createTestRegistry({
        async definition() {
          const sandbox = createTestSandbox("failed-setup-sandbox");
          await sandbox.run({ command: "prepare" });
          throw new Error("authored setup failed");
        },
      }),
    });

    await expect(access.get()).rejects.toThrow("authored setup failed");
    expect(countActiveSandboxHandles()).toBe(1);

    await shutdownActiveSandboxHandles();
    expect(shutdownTestSandbox).toHaveBeenCalledWith("failed-setup-sandbox");
  });
});

async function createTestTemplateKey(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly template: SandboxTemplate;
}): Promise<string> {
  const nodeId = input.nodeId ?? "__root__";
  const registered = input.registry.sandbox;
  const revision = await createRuntimeSandboxDefinitionRevision({
    nodeId,
    sourceHash: registered.definition.sourceHash,
    sourceId: registered.definition.sourceId,
    workspaceResourceRoot: registered.workspaceResourceRoot,
  });
  return await createRuntimeSandboxTemplateKey({
    compiledArtifactsSource: input.compiledArtifactsSource,
    exportName: "template",
    implementationId: getSandboxTemplateInternal(input.template).implementationId,
    nodeId,
    revision,
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
