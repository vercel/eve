import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveMicrosandboxSessionHandlesForTest,
  createMicrosandboxHandle,
  prewarmMicrosandboxTemplate,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { SandboxTemplateNotProvisionedError } from "#public/definitions/sandbox-backend.js";
import {
  MICROSANDBOX_DEFAULT_IMAGE,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";

const runtimeMocks = vi.hoisted(() => ({
  connectMicrosandbox: vi.fn(),
  createPreparedMicrosandbox: vi.fn(),
  createProviderName: vi.fn((prefix: string, key: string) => `${prefix}-${key}`),
  doesPathExist: vi.fn(async () => false),
  loadMicrosandboxModule: vi.fn(async () => ({}) as never),
  removeSnapshotIfExists: vi.fn(async () => {}),
  sandboxExists: vi.fn(async () => false),
  snapshotExists: vi.fn(async () => true),
}));

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async (_path: string, _options?: unknown) => {}),
  rename: vi.fn(async (_oldPath: string, _newPath: string) => {}),
  rm: vi.fn(async (_path: string, _options?: unknown) => {}),
}));

const metadataMocks = vi.hoisted(() => ({
  readSessionMetadata: vi.fn(async () => null),
  readSessionMetadataRecord: vi.fn((value: unknown) => value ?? null),
  readTemplateMetadata: vi.fn(async () => ({
    optionsHash: "options-hash",
    snapshotName: "template-snapshot",
    version: 2,
  })),
  resolveMicrosandboxMetadataPath: vi.fn((rootPath: string) => `${rootPath}/metadata.json`),
  writeTemplateMetadata: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => fsMocks);

vi.mock("#execution/sandbox/bindings/microsandbox-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/sandbox/bindings/microsandbox-runtime.js")>()),
  ...runtimeMocks,
}));

vi.mock("#execution/sandbox/bindings/microsandbox-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#execution/sandbox/bindings/microsandbox-metadata.js")
  >()),
  ...metadataMocks,
}));

describe("createMicrosandboxHandle", () => {
  beforeEach(() => {
    clearActiveMicrosandboxSessionHandlesForTest();
    vi.clearAllMocks();
    runtimeMocks.loadMicrosandboxModule.mockResolvedValue({} as never);
    runtimeMocks.connectMicrosandbox.mockReset();
    runtimeMocks.sandboxExists.mockResolvedValue(false);
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    metadataMocks.readSessionMetadata.mockResolvedValue(null);
    metadataMocks.readSessionMetadataRecord.mockImplementation((value: unknown) => value ?? null);
    metadataMocks.readTemplateMetadata.mockResolvedValue({
      optionsHash: "options-hash",
      snapshotName: "template-snapshot",
      version: 2,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reuses the active same-process session instead of reopening from the template", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await firstHandle.session.writeTextFile({
      content: "survives active cache",
      path: "date.txt",
    });
    const state = await firstHandle.captureState();

    const secondHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: {
        ...createInput,
        existingMetadata: state.metadata,
      },
      options,
      optionsHash: "options-hash",
    });

    await expect(secondHandle.session.readTextFile({ path: "date.txt" })).resolves.toBe(
      "survives active cache",
    );
    expect(vm.detach).not.toHaveBeenCalled();
    expect(secondHandle).toBe(firstHandle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(1);
  });

  it("releases a captured production session and reconnects from its snapshot", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const vm = createFakeMicrosandboxVm("session-key", {
      stateSnapshotName: "captured-session-snapshot",
    });
    const reconnectedVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.sandboxExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockResolvedValue(reconnectedVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const state = await firstHandle.captureState();

    const nextHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: { ...createInput, existingMetadata: state.metadata },
      options,
      optionsHash: "options-hash",
    });

    expect(vm.detach).toHaveBeenCalledTimes(1);
    expect(nextHandle).not.toBe(firstHandle);
    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          stateSnapshotName: "captured-session-snapshot",
        }),
      }),
    );
  });

  it("deduplicates replacement openers waiting for production capture", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const detach = createDeferred<void>();
    const vm = createFakeMicrosandboxVm("session-key", {
      detach: async () => await detach.promise,
      stateSnapshotName: "captured-session-snapshot",
    });
    const reconnectedVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.sandboxExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockResolvedValue(reconnectedVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const capturePromise = firstHandle.captureState();
    await vi.waitFor(() => expect(vm.detach).toHaveBeenCalledTimes(1));

    const nextHandlePromise = createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const concurrentHandlePromise = createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await Promise.resolve();
    expect(runtimeMocks.connectMicrosandbox).not.toHaveBeenCalled();

    detach.resolve();
    const [state, nextHandle, concurrentHandle] = await Promise.all([
      capturePromise,
      nextHandlePromise,
      concurrentHandlePromise,
    ]);

    expect(nextHandle).not.toBe(firstHandle);
    expect(concurrentHandle).toBe(nextHandle);
    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: state.metadata }),
    );
  });

  it("deduplicates overlapping captures before releasing a waiting opener", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const capture = createDeferred<{
      readonly optionsHash: string;
      readonly sandboxName: string;
      readonly stateSnapshotName: string;
      readonly version: 2;
    }>();
    const vm = createFakeMicrosandboxVm("session-key", {
      captureState: async () => await capture.promise,
    });
    const reconnectedVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.sandboxExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockResolvedValue(reconnectedVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const firstCapture = firstHandle.captureState();
    await vi.waitFor(() => expect(vm.captureState).toHaveBeenCalledTimes(1));
    const concurrentCapture = firstHandle.captureState();
    const nextHandlePromise = createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });

    capture.resolve({
      optionsHash: "options-hash",
      sandboxName: "active-sandbox",
      stateSnapshotName: "captured-session-snapshot",
      version: 2,
    });
    const [firstState, concurrentState, nextHandle] = await Promise.all([
      firstCapture,
      concurrentCapture,
      nextHandlePromise,
    ]);

    expect(concurrentState).toEqual(firstState);
    expect(vm.captureState).toHaveBeenCalledTimes(1);
    expect(vm.detach).toHaveBeenCalledTimes(1);
    expect(nextHandle).not.toBe(firstHandle);
    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
  });

  it("detaches and evicts a production handle when capture fails", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const vm = createFakeMicrosandboxVm("session-key", {
      captureState: async () => {
        throw new Error("metadata write failed");
      },
    });
    const replacementVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox
      .mockResolvedValueOnce(vm)
      .mockResolvedValueOnce(replacementVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await expect(firstHandle.captureState()).rejects.toThrow("metadata write failed");

    const nextHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });

    expect(vm.detach).toHaveBeenCalledTimes(1);
    expect(nextHandle).not.toBe(firstHandle);
  });

  it("fails capture and evicts the handle when the SDK client cannot detach", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const vm = createFakeMicrosandboxVm("session-key", {
      detach: async () => {
        throw new Error("detach failed");
      },
      stateSnapshotName: "captured-session-snapshot",
    });
    const replacementVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox
      .mockResolvedValueOnce(vm)
      .mockResolvedValueOnce(replacementVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await expect(firstHandle.captureState()).rejects.toThrow("detach failed");

    const nextHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });

    expect(nextHandle).not.toBe(firstHandle);
  });

  it("does not let an old captured handle evict its replacement", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const vm = createFakeMicrosandboxVm("session-key", {
      stateSnapshotName: "captured-session-snapshot",
    });
    const reconnectedVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.sandboxExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockResolvedValue(reconnectedVm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const state = await firstHandle.captureState();
    const replacementHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: { ...createInput, existingMetadata: state.metadata },
      options,
      optionsHash: "options-hash",
    });

    await firstHandle.shutdown();
    const reusedHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: { ...createInput, existingMetadata: state.metadata },
      options,
      optionsHash: "options-hash",
    });

    expect(reusedHandle).toBe(replacementHandle);
    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
  });

  it("rejects capture through an old handle while and after its replacement opens", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
    const opening = createDeferred<ReturnType<typeof createFakeMicrosandboxVm>>();
    const vm = createFakeMicrosandboxVm("session-key", {
      stateSnapshotName: "captured-session-snapshot",
    });
    const reconnectedVm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.sandboxExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockImplementation(async () => await opening.promise);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    const state = await firstHandle.captureState();
    const replacementPromise = createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: { ...createInput, existingMetadata: state.metadata },
      options,
      optionsHash: "options-hash",
    });
    await vi.waitFor(() => expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1));

    await expect(firstHandle.captureState()).rejects.toThrow("no longer active");
    opening.resolve(reconnectedVm);
    await replacementPromise;
    await expect(firstHandle.captureState()).rejects.toThrow("no longer active");
    expect(vm.captureState).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "shutdown"] as const)(
    "keeps the capture barrier when %s overlaps capture",
    async (method) => {
      vi.stubEnv(EVE_DEV_ENV_FLAG, "0");
      const capture = createDeferred<{
        readonly optionsHash: string;
        readonly sandboxName: string;
        readonly stateSnapshotName: string;
        readonly version: 2;
      }>();
      const vm = createFakeMicrosandboxVm("session-key", {
        captureState: async () => await capture.promise,
      });
      const reconnectedVm = createFakeMicrosandboxVm("session-key");
      runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
      runtimeMocks.sandboxExists.mockResolvedValue(true);
      runtimeMocks.connectMicrosandbox.mockResolvedValue(reconnectedVm);
      const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
      const createInput = {
        runtimeContext: { appRoot: "/tmp/eve-app" },
        sessionKey: "session-key",
        templateKey: "template-key",
      };

      const firstHandle = await createMicrosandboxHandle({
        backendName: "microsandbox",
        createInput,
        options,
        optionsHash: "options-hash",
      });
      const capturePromise = firstHandle.captureState();
      await vi.waitFor(() => expect(vm.captureState).toHaveBeenCalledTimes(1));
      await firstHandle[method]();
      const nextHandlePromise = createMicrosandboxHandle({
        backendName: "microsandbox",
        createInput,
        options,
        optionsHash: "options-hash",
      });
      await Promise.resolve();
      expect(runtimeMocks.connectMicrosandbox).not.toHaveBeenCalled();

      capture.resolve({
        optionsHash: "options-hash",
        sandboxName: "active-sandbox",
        stateSnapshotName: "captured-session-snapshot",
        version: 2,
      });
      const [nextHandle] = await Promise.all([nextHandlePromise, capturePromise]);

      expect(nextHandle).not.toBe(firstHandle);
      expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
    },
  );

  it("creates fresh from the template when persisted session state disappeared", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.connectMicrosandbox.mockResolvedValueOnce(null);
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });

    const handle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput: {
        existingMetadata: {
          optionsHash: "options-hash",
          sandboxName: "deleted-sandbox",
          stateSnapshotName: "deleted-session-snapshot",
          version: 2,
        },
        runtimeContext: { appRoot: "/tmp/eve-app" },
        sessionKey: "session-key",
        templateKey: "template-key",
      },
      options,
      optionsHash: "options-hash",
    });

    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        fromSnapshot: "template-snapshot",
        sessionKey: "session-key",
        setupBaseRuntime: false,
      }),
    );
    await expect(handle.captureState()).resolves.toMatchObject({
      backendName: "microsandbox",
      sessionKey: "session-key",
    });
  });

  it("stops the VM and evicts the active-session cache on shutdown", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const handle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await handle.shutdown();

    expect(vm.shutdown).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    expect(nextHandle).not.toBe(handle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(2);
  });

  it("stops the VM and evicts the active-session cache on an authored stop", async () => {
    vi.stubEnv(EVE_DEV_ENV_FLAG, "1");
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      runtimeContext: { appRoot: "/tmp/eve-app" },
      sessionKey: "session-key",
      templateKey: "template-key",
    };

    const handle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    await handle.stop();
    await expect(handle.captureState()).rejects.toThrow("no longer active");

    expect(vm.stop).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxHandle({
      backendName: "microsandbox",
      createInput,
      options,
      optionsHash: "options-hash",
    });
    expect(nextHandle).not.toBe(handle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(2);
  });

  it("reports a missing template snapshot race as not provisioned", async () => {
    runtimeMocks.createPreparedMicrosandbox.mockRejectedValueOnce(
      new Error("snapshot template-snapshot not found"),
    );
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });

    await expect(
      createMicrosandboxHandle({
        backendName: "microsandbox",
        createInput: {
          runtimeContext: { appRoot: "/tmp/eve-app" },
          sessionKey: "session-key",
          templateKey: "template-key",
        },
        options,
        optionsHash: "options-hash",
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateNotProvisionedError);
  });
});

describe("prewarmMicrosandboxTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.loadMicrosandboxModule.mockResolvedValue({} as never);
    runtimeMocks.snapshotExists.mockResolvedValue(false);
    metadataMocks.readTemplateMetadata.mockResolvedValue({
      optionsHash: "options-hash",
      snapshotName: "missing-template-snapshot",
      version: 2,
    });
  });

  it("replaces stale template metadata after rebuilding a missing snapshot", async () => {
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(createFakeMicrosandboxVm("template"));
    const appRoot = "/tmp/eve-app";
    const templateRootPath = "/tmp/eve-app/.eve/sandbox-cache/microsandbox/templates/template-key";

    const result = await prewarmMicrosandboxTemplate({
      backendName: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      prewarmInput: {
        runtimeContext: { appRoot },
        seedFiles: [],
        templateKey: "template-key",
      },
    });

    const replaceCallIndex = fsMocks.rm.mock.calls.findIndex(([path]) => path === templateRootPath);
    const renameOrder = fsMocks.rename.mock.invocationCallOrder[0];
    const replaceOrder = fsMocks.rm.mock.invocationCallOrder[replaceCallIndex];
    expect(replaceCallIndex).toBeGreaterThanOrEqual(0);
    if (renameOrder === undefined || replaceOrder === undefined) {
      throw new Error("Expected template replacement before rename.");
    }
    expect(replaceOrder).toBeLessThan(renameOrder);
    expect(fsMocks.rename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/tmp\/eve-app\/\.eve\/sandbox-cache\/microsandbox\/templates\/template-key\..+\.tmp$/u,
      ),
      templateRootPath,
    );
    expect(result).toEqual({ reused: false });
  });

  it("writes seed files before bootstrap and snapshots bootstrap outputs", async () => {
    const vm = createFakeMicrosandboxVm("template");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);

    await prewarmMicrosandboxTemplate({
      backendName: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      prewarmInput: {
        bootstrap: async ({ use }) => {
          const sandbox = await use();
          await expect(sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
            "authored seed",
          );
          await sandbox.writeTextFile({
            content: "bootstrap output",
            path: "/workspace/bootstrap.txt",
          });
        },
        runtimeContext: { appRoot: "/tmp/eve-app" },
        seedFiles: [{ content: "authored seed", path: "/workspace/seed.txt" }],
        templateKey: "template-key",
      },
    });

    await expect(vm.readFileBytes("/workspace/bootstrap.txt")).resolves.toEqual(
      Buffer.from("bootstrap output"),
    );
    expect(vm.writeFiles.mock.invocationCallOrder[1]).toBeLessThan(
      vm.stopAndSnapshot.mock.invocationCallOrder[0]!,
    );
  });
});

function createFakeMicrosandboxVm(
  sessionKey: string,
  options: {
    readonly captureState?: (optionsHash: string) => Promise<{
      readonly optionsHash: string;
      readonly sandboxName: string;
      readonly stateSnapshotName?: string;
      readonly version: 2;
    }>;
    readonly detach?: () => Promise<void>;
    readonly stateSnapshotName?: string;
  } = {},
) {
  const files = new Map<string, Buffer>();

  return {
    id: sessionKey,
    captureState: vi.fn(
      options.captureState ??
        (async (optionsHash: string) => ({
          optionsHash,
          sandboxName: "active-sandbox",
          stateSnapshotName: options.stateSnapshotName,
          version: 2 as const,
        })),
    ),
    detach: vi.fn(options.detach ?? (async () => {})),
    stop: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    async readFileBytes(path: string) {
      return files.get(path) ?? null;
    },
    async removePath({ path }: { readonly path: string }) {
      files.delete(path);
    },
    async removePersisted() {},
    async setNetworkPolicy() {},
    async spawn() {
      throw new Error("spawn is not used by this test.");
    },
    stopAndSnapshot: vi.fn(async () => {}),
    writeFiles: vi.fn(
      async (nextFiles: ReadonlyArray<{ readonly content: Uint8Array; readonly path: string }>) => {
        for (const file of nextFiles) {
          files.set(file.path, Buffer.from(file.content));
        }
      },
    ),
    async writeMetadata() {},
  };
}

function createDeferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
