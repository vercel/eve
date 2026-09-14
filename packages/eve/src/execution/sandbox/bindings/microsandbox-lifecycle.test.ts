import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveMicrosandboxSessionHandlesForTest,
  createMicrosandboxHandle as createMicrosandboxHandleImplementation,
  prewarmMicrosandboxTemplate as prewarmMicrosandboxTemplateImplementation,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { createSandboxProviderResources } from "#shared/sandbox-provider.js";
import { SandboxTemplateNotProvisionedError } from "#shared/sandbox-template-error.js";
import {
  MICROSANDBOX_DEFAULT_IMAGE,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";

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

function createMicrosandboxHandle(
  input: Omit<Parameters<typeof createMicrosandboxHandleImplementation>[0], "context"> & {
    context: Partial<Parameters<typeof createMicrosandboxHandleImplementation>[0]["context"]> &
      Pick<
        Parameters<typeof createMicrosandboxHandleImplementation>[0]["context"],
        "appRoot" | "sandboxName"
      >;
  },
) {
  return createMicrosandboxHandleImplementation({
    ...input,
    context: {
      handle: (providerHandle) => providerHandle,
      options: undefined,
      resources: {},
      ...input.context,
    },
    prepared: {
      artifact: {
        optionsHash: input.optionsHash,
        snapshotName: "template-snapshot",
        version: 2,
      },
      templateName: "template-key",
    },
  });
}

function prewarmMicrosandboxTemplate(
  input: Omit<Parameters<typeof prewarmMicrosandboxTemplateImplementation>[0], "context"> & {
    context: Partial<Parameters<typeof prewarmMicrosandboxTemplateImplementation>[0]["context"]> &
      Pick<
        Parameters<typeof prewarmMicrosandboxTemplateImplementation>[0]["context"],
        "appRoot" | "templateName"
      >;
  },
) {
  return prewarmMicrosandboxTemplateImplementation({
    ...input,
    context: {
      resources: {},
      runPreparation: async () => {},
      ...input.context,
    },
  });
}

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

  it("reuses the active same-process session instead of reopening from the template", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
      templateName: "template-key",
    };

    const firstHandle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    await firstHandle.sandbox.writeTextFile({
      content: "survives active cache",
      path: "date.txt",
    });
    const state = await firstHandle.captureMetadata?.();

    const secondHandle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: {
        ...createInput,
        existing: state,
      },
      options,
      optionsHash: "options-hash",
    });

    await expect(secondHandle.sandbox.readTextFile({ path: "date.txt" })).resolves.toBe(
      "survives active cache",
    );
    expect(secondHandle).toBe(firstHandle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(1);
  });

  it("creates fresh from the template when persisted session state disappeared", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.connectMicrosandbox.mockResolvedValueOnce(null);
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });

    const handle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: {
        existing: {
          optionsHash: "options-hash",
          sandboxName: "deleted-sandbox",
          stateSnapshotName: "deleted-session-snapshot",
          version: 2,
        },
        appRoot: "/tmp/eve-app",
        sandboxName: "session-key",
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
    await expect(handle.captureMetadata?.()).resolves.toMatchObject({
      optionsHash: "options-hash",
      sandboxName: "active-sandbox",
    });
  });

  it("stops the VM and evicts the active-session cache on shutdown", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
      templateName: "template-key",
    };

    const handle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    await handle.shutdown();

    expect(vm.shutdown).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    expect(nextHandle).not.toBe(handle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(2);
  });

  it("stops the VM and evicts the active-session cache on an authored stop", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
      templateName: "template-key",
    };

    const handle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    await handle.stop();

    expect(vm.stop).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    expect(nextHandle).not.toBe(handle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(2);
  });

  it("deletes persisted state and evicts the active-session cache", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const createInput = {
      appRoot: "/tmp/eve-app",
      sandboxName: "session-key",
      templateName: "template-key",
    };

    const handle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
      options,
      optionsHash: "options-hash",
    });
    await handle.delete();

    expect(vm.shutdown).toHaveBeenCalledTimes(1);
    expect(vm.removePersisted).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxHandle({
      providerName: "microsandbox",
      context: createInput,
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
        providerName: "microsandbox",
        context: {
          appRoot: "/tmp/eve-app",
          sandboxName: "session-key",
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
      providerName: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      context: {
        appRoot,
        resources: {},
        runPreparation: async () => {},
        templateName: "template-key",
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
    expect(result).toMatchObject({ reused: false });
  });

  it("writes seed files before preparation and snapshots preparation outputs", async () => {
    const vm = createFakeMicrosandboxVm("template");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);

    await prewarmMicrosandboxTemplate({
      providerName: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      context: {
        runPreparation: async (sandbox) => {
          await expect(sandbox.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
            "authored seed",
          );
          await sandbox.writeTextFile({
            content: "bootstrap output",
            path: "/workspace/bootstrap.txt",
          });
        },
        appRoot: "/tmp/eve-app",
        resources: createSandboxProviderResources({
          resourcesKey: "resources",
          seedFiles: [{ content: "authored seed", path: "/workspace/seed.txt" }],
        }),
        templateName: "template-key",
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

function createFakeMicrosandboxVm(sandboxName: string) {
  const files = new Map<string, Buffer>();

  return {
    id: sandboxName,
    async captureState(optionsHash: string) {
      return {
        optionsHash,
        sandboxName: "active-sandbox",
        version: 2,
      };
    },
    async detach() {},
    stop: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    async readFileBytes(path: string) {
      return files.get(path) ?? null;
    },
    async removePath({ path }: { readonly path: string }) {
      files.delete(path);
    },
    removePersisted: vi.fn(async () => {}),
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
