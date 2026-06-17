import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
} from "#public/definitions/sandbox-backend.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";
import { ContextContainer, contextStorage, loadContext } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { Session } from "#context/keys.js";
import {
  clearInitializedDevelopmentSandboxBackendNames,
  EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV,
  getInitializedDevelopmentSandboxBackendNames,
} from "#execution/sandbox/development-run.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";

const mocks = vi.hoisted(() => ({
  prewarmAppSandboxes: vi.fn(async () => {}),
  waitForSandboxTemplatePrewarmLock: vi.fn<(input: unknown) => Promise<void>>(async () => {}),
  waitForDevelopmentSandboxPrewarm: vi.fn<(input: unknown) => Promise<void>>(async () => {}),
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

function createTestRegistry(
  definition: Partial<ResolvedSandboxDefinition>,
  backend: SandboxBackend,
): RuntimeSandboxRegistry {
  const resolved: ResolvedSandboxDefinition = {
    backend,
    logicalPath: "agent/sandbox/sandbox.ts",
    sourceHash: "test-source-hash",
    sourceId: "agent/sandbox/sandbox",
    sourceKind: "module",
    ...definition,
  };

  return {
    sandbox: {
      definition: resolved,
      workspaceResourceRoot: { contentHash: "test-content-hash", logicalPath: "", rootEntries: [] },
    },
  };
}

function createBackend(): SandboxBackend {
  const sandbox = mockSandbox({ id: "sbx_session_auth" });
  const create = vi.fn(async (input: SandboxBackendCreateInput) => {
    return {
      captureState: async () => ({
        backendName: "test",
        metadata: {},
        sessionKey: input.sessionKey,
      }),
      useSessionFn: async () => sandbox.session,
      dispose: async () => {},
      session: sandbox.session,
    };
  });

  return { create, name: "test", prewarm: vi.fn() };
}

async function ensure(input: {
  readonly compiledArtifactsSource?: RuntimeCompiledArtifactsSource;
  readonly runOnSession?: (callback: () => Promise<void>) => Promise<void>;
  readonly registry: RuntimeSandboxRegistry;
  readonly tags?: Record<string, string>;
}) {
  return await ensureSandboxAccess({
    compiledArtifactsSource:
      input.compiledArtifactsSource ?? createBundledRuntimeCompiledArtifactsSource(),
    nodeId: "__root__",
    registry: input.registry,
    runOnSession: input.runOnSession,
    sessionId: "session_1",
    state: null,
    tags: input.tags,
  });
}

function createSession(): Session {
  return {
    auth: {
      current: {
        attributes: {},
        authenticator: "slack-webhook",
        issuer: "slack:T123",
        principalId: "slack:T123:U123",
        principalType: "user",
      },
      initiator: null,
    },
    sessionId: "session_1",
    turn: { id: "turn_1", sequence: 0 },
  };
}

describe("ensureSandboxAccess", () => {
  beforeEach(() => {
    mocks.prewarmAppSandboxes.mockReset();
    mocks.prewarmAppSandboxes.mockResolvedValue(undefined);
    mocks.waitForSandboxTemplatePrewarmLock.mockReset();
    mocks.waitForSandboxTemplatePrewarmLock.mockResolvedValue(undefined);
    mocks.waitForDevelopmentSandboxPrewarm.mockReset();
    mocks.waitForDevelopmentSandboxPrewarm.mockResolvedValue(undefined);
  });

  it("waits for background dev prewarm before creating a templated sandbox", async () => {
    const prewarm = createDeferred<void>();
    mocks.waitForDevelopmentSandboxPrewarm.mockReturnValueOnce(prewarm.promise);
    const bootstrap = vi.fn();
    const backend = createBackend();
    const registry = createTestRegistry({ bootstrap }, backend);
    const appRoot = process.cwd();

    const access = await ensure({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
      registry,
    });
    const getPromise = access.get();

    await vi.waitFor(() => {
      expect(mocks.waitForDevelopmentSandboxPrewarm).toHaveBeenCalledWith(
        expect.objectContaining({
          appRoot,
          compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
        }),
      );
    });
    expect(backend.create).not.toHaveBeenCalled();

    prewarm.resolve();
    await getPromise;

    expect(backend.create).toHaveBeenCalledTimes(1);
  });

  it("prewarms and retries once when a templated sandbox is missing at first use", async () => {
    const backend = createBackend();
    const registry = createTestRegistry({ bootstrap: vi.fn() }, backend);
    const appRoot = process.cwd();
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    vi.mocked(backend.create).mockRejectedValueOnce(
      new SandboxTemplateNotProvisionedError({
        backendName: "test",
        templateKey: "missing-template",
      }),
    );

    const access = await ensure({
      compiledArtifactsSource,
      registry,
    });
    await access.get();

    expect(mocks.prewarmAppSandboxes).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
        compiledArtifactsSource,
      }),
    );
    expect(backend.create).toHaveBeenCalledTimes(2);
  });

  it("prewarms and retries when a dev-runtime copy reports a missing template", async () => {
    const backend = createBackend();
    const registry = createTestRegistry({ bootstrap: vi.fn() }, backend);
    const appRoot = process.cwd();
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(appRoot);
    vi.mocked(backend.create).mockRejectedValueOnce({
      backendName: "test",
      message: 'Sandbox template "missing-template" is not provisioned for backend "test".',
      name: "SandboxTemplateNotProvisionedError",
      templateKey: "missing-template",
    });

    const access = await ensure({
      compiledArtifactsSource,
      registry,
    });
    await access.get();

    expect(mocks.prewarmAppSandboxes).toHaveBeenCalledTimes(1);
    expect(backend.create).toHaveBeenCalledTimes(2);
  });

  it("opens dev snapshot artifact sandboxes with the authored app root", async () => {
    const backend = createBackend();
    const registry = createTestRegistry({ bootstrap: vi.fn() }, backend);
    const appRoot = process.cwd();
    const snapshotRoot = `${appRoot}/.eve/dev-runtime/snapshots/current/app`;
    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(snapshotRoot, {
      moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
      sandboxAppRoot: appRoot,
    });

    const access = await ensure({
      compiledArtifactsSource,
      registry,
    });
    await access.get();

    expect(mocks.waitForDevelopmentSandboxPrewarm).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
        compiledArtifactsSource,
      }),
    );
    expect(mocks.waitForSandboxTemplatePrewarmLock).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
      }),
    );
    expect(backend.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: { appRoot },
      }),
    );
  });

  it("runs onSession inside the active eve context", async () => {
    const ctx = new ContextContainer();
    const session = createSession();
    ctx.set(SessionKey, session);

    let observedSession: Session | undefined;
    let observedSessionId: string | undefined;
    const onSession = vi.fn((input) => {
      observedSession = loadContext().require(SessionKey);
      observedSessionId = input.ctx.session.id;
    });
    const backend = createBackend();
    const registry = createTestRegistry({ onSession }, backend);

    const access = await ensure({
      registry,
      runOnSession: async (callback) => await contextStorage.run(ctx, callback),
    });
    await access.get();

    expect(observedSession).toBe(session);
    expect(observedSessionId).toBe("session_1");
    expect(onSession).toHaveBeenCalledWith({
      ctx: expect.objectContaining({
        session: expect.objectContaining({ id: "session_1" }),
      }),
      use: expect.any(Function),
    });
  });

  it("does not pass bootstrap or seed files to runtime create", async () => {
    const bootstrap = vi.fn();
    const backend = createBackend();
    const registry = createTestRegistry({ bootstrap, revalidationKey: "test-bootstrap" }, backend);

    const access = await ensure({ registry });
    await access.get();

    expect(bootstrap).not.toHaveBeenCalled();
    expect(backend.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        bootstrap: expect.anything(),
        seedFiles: expect.anything(),
      }),
    );
  });

  it("passes a null template key for sandboxes with no bootstrap or seed files", async () => {
    const backend = createBackend();
    const registry = createTestRegistry({}, backend);

    const access = await ensure({ registry });
    await access.get();

    expect(backend.create).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: null,
      }),
    );
  });

  it("passes runtime tags to the sandbox backend", async () => {
    const backend = createBackend();
    const registry = createTestRegistry({}, backend);

    const access = await ensure({
      registry,
      tags: {
        agent: "weather-agent",
        channel: "http",
        sessionId: "session_1",
      },
    });
    await access.get();

    expect(backend.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: {
          agent: "weather-agent",
          channel: "http",
          sessionId: "session_1",
        },
      }),
    );
  });

  it("records the backend after a development sandbox is initialized", async () => {
    process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV] = "dev-run-test";
    const backend = createBackend();
    const registry = createTestRegistry({}, backend);

    try {
      const access = await ensure({ registry });
      await access.get();

      expect(getInitializedDevelopmentSandboxBackendNames("dev-run-test")).toEqual(["test"]);
    } finally {
      clearInitializedDevelopmentSandboxBackendNames("dev-run-test");
      delete process.env[EVE_DEVELOPMENT_SANDBOX_RUN_ID_ENV];
    }
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
