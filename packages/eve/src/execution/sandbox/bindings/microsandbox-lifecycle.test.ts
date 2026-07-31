import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveMicrosandboxSessionHandlesForTest,
  createMicrosandboxResource,
  prewarmMicrosandboxTemplate,
  referenceMicrosandboxResource,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { SandboxTemplateUnavailableError } from "#shared/sandbox-errors.js";
import {
  MICROSANDBOX_DEFAULT_IMAGE,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import type { MicrosandboxSessionMetadata } from "#execution/sandbox/bindings/microsandbox-metadata.js";

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
  utimes: vi.fn(async (_path: string, _atime: Date, _mtime: Date) => {}),
}));

const metadataMocks = vi.hoisted(() => ({
  readSessionMetadata: vi.fn<() => Promise<MicrosandboxSessionMetadata | null>>(async () => null),
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

const TEMPLATE_REFERENCE = {
  optionsHash: "options-hash",
  snapshotName: "template-snapshot",
  templateId: "template-key",
} as const;

function providerContext() {
  return {
    appRoot: "/tmp/eve-app",
    resourceId: "session-key",
    signal: new AbortController().signal,
  };
}

describe("createMicrosandboxResource", () => {
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
    const firstHandle = await createMicrosandboxResource({
      configuration: {},
      context: providerContext(),
      provider: "microsandbox",
      options,
      optionsHash: "options-hash",
      template: TEMPLATE_REFERENCE,
    });
    await firstHandle.session.writeTextFile({
      content: "survives active cache",
      path: "date.txt",
    });
    const reference = await referenceMicrosandboxResource(firstHandle);

    const secondHandle = await createMicrosandboxResource({
      configuration: {},
      context: providerContext(),
      provider: "microsandbox",
      options,
      optionsHash: "options-hash",
      reference,
    });

    await expect(secondHandle.session.readTextFile({ path: "date.txt" })).resolves.toBe(
      "survives active cache",
    );
    expect(secondHandle).toBe(firstHandle);
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledTimes(1);
  });

  it("prefers the provider-side session pointer over stale workflow metadata", async () => {
    const currentMetadata = {
      optionsHash: "options-hash",
      sandboxName: "current-sandbox",
      stateSnapshotName: "current-snapshot",
      version: 2,
    } as const;
    const vm = createFakeMicrosandboxVm("session-key");
    metadataMocks.readSessionMetadata.mockResolvedValue(currentMetadata);
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    runtimeMocks.connectMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });

    await createMicrosandboxResource({
      configuration: {},
      context: providerContext(),
      provider: "microsandbox",
      reference: {
        configuration: {},
        metadata: {
          optionsHash: "options-hash",
          sandboxName: "stale-sandbox",
          stateSnapshotName: "deleted-snapshot",
          version: 2,
        },
        sessionKey: "session-key",
      },
      options,
      optionsHash: "options-hash",
    });

    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: currentMetadata }),
    );
  });

  it("does not replace a persisted session whose provider state disappeared", async () => {
    runtimeMocks.connectMicrosandbox.mockResolvedValueOnce(null);
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });

    await expect(
      createMicrosandboxResource({
        configuration: {},
        context: providerContext(),
        provider: "microsandbox",
        reference: {
          configuration: {},
          metadata: {
            optionsHash: "options-hash",
            sandboxName: "deleted-sandbox",
            stateSnapshotName: "deleted-session-snapshot",
            version: 2,
          },
          sessionKey: "session-key",
        },
        options,
        optionsHash: "options-hash",
      }),
    ).rejects.toThrow(
      'Persisted sandbox "session-key" is unavailable from provider "microsandbox"',
    );

    expect(runtimeMocks.connectMicrosandbox).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.createPreparedMicrosandbox).not.toHaveBeenCalled();
  });

  it("stops the VM and evicts the active-session cache on shutdown", async () => {
    const vm = createFakeMicrosandboxVm("session-key");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);
    const options = resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE });
    const handle = await createMicrosandboxResource({
      configuration: {},
      context: providerContext(),
      provider: "microsandbox",
      options,
      optionsHash: "options-hash",
      template: TEMPLATE_REFERENCE,
    });
    await handle.shutdown();

    expect(vm.shutdown).toHaveBeenCalledTimes(1);

    const nextHandle = await createMicrosandboxResource({
      configuration: {},
      context: providerContext(),
      provider: "microsandbox",
      options,
      optionsHash: "options-hash",
      template: TEMPLATE_REFERENCE,
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
      createMicrosandboxResource({
        configuration: {},
        context: providerContext(),
        provider: "microsandbox",
        options,
        optionsHash: "options-hash",
        template: TEMPLATE_REFERENCE,
      }),
    ).rejects.toBeInstanceOf(SandboxTemplateUnavailableError);
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

  it("reuses a cached snapshot when its base image is immutable", async () => {
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    metadataMocks.readTemplateMetadata.mockResolvedValue({
      optionsHash: "options-hash",
      snapshotName: "template-snapshot",
      version: 2,
    });

    const result = await prewarmMicrosandboxTemplate({
      appRoot: "/tmp/eve-app",
      configuration: {},
      provider: "microsandbox",
      options: resolveMicrosandboxOptions({
        image: `ghcr.io/vercel/eve@sha256:${"a".repeat(64)}`,
      }),
      optionsHash: "options-hash",
      async prepare() {},
      templateId: "template-key",
    });

    expect(result).toEqual(TEMPLATE_REFERENCE);
    expect(runtimeMocks.createPreparedMicrosandbox).not.toHaveBeenCalled();
  });

  it("rebuilds a cached snapshot when its base image is a floating tag", async () => {
    runtimeMocks.snapshotExists.mockResolvedValue(true);
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(createFakeMicrosandboxVm("template"));

    const result = await prewarmMicrosandboxTemplate({
      appRoot: "/tmp/eve-app",
      configuration: {},
      provider: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      async prepare() {},
      templateId: "template-key",
    });

    expect(result).toEqual({
      optionsHash: "options-hash",
      snapshotName: "eve-sbx-tpl-template-key",
      templateId: "template-key",
    });
    expect(runtimeMocks.createPreparedMicrosandbox).toHaveBeenCalledOnce();
  });

  it("replaces stale template metadata after rebuilding a missing snapshot", async () => {
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(createFakeMicrosandboxVm("template"));
    const appRoot = "/tmp/eve-app";
    const templateRootPath = "/tmp/eve-app/.eve/sandbox-cache/microsandbox/templates/template-key";

    const result = await prewarmMicrosandboxTemplate({
      appRoot,
      configuration: {},
      provider: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      async prepare() {},
      templateId: "template-key",
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
    expect(result).toEqual({
      optionsHash: "options-hash",
      snapshotName: "eve-sbx-tpl-template-key",
      templateId: "template-key",
    });
  });

  it("writes seed files before preparation and snapshots preparation outputs", async () => {
    const vm = createFakeMicrosandboxVm("template");
    runtimeMocks.createPreparedMicrosandbox.mockResolvedValue(vm);

    await prewarmMicrosandboxTemplate({
      appRoot: "/tmp/eve-app",
      configuration: {},
      provider: "microsandbox",
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      optionsHash: "options-hash",
      prepare: async (resource) => {
        await resource.session.writeTextFile({
          content: "authored seed",
          path: "/workspace/seed.txt",
        });
        await expect(resource.session.readTextFile({ path: "/workspace/seed.txt" })).resolves.toBe(
          "authored seed",
        );
        await resource.session.writeTextFile({
          content: "preparation output",
          path: "/workspace/preparation.txt",
        });
      },
      templateId: "template-key",
    });

    await expect(vm.readFileBytes("/workspace/preparation.txt")).resolves.toEqual(
      Buffer.from("preparation output"),
    );
    expect(vm.writeFiles.mock.invocationCallOrder[1]).toBeLessThan(
      vm.stopAndSnapshot.mock.invocationCallOrder[0]!,
    );
  });
});

function createFakeMicrosandboxVm(sessionKey: string) {
  const files = new Map<string, Buffer>();

  return {
    id: sessionKey,
    async captureState(optionsHash: string) {
      return {
        optionsHash,
        sandboxName: "active-sandbox",
        stateSnapshotName: "active-snapshot",
        version: 2,
      };
    },
    async detach() {},
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
