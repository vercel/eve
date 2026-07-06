import { describe, expect, it, vi } from "vitest";

import type { MicrosandboxSessionMetadata } from "#execution/sandbox/bindings/microsandbox-metadata.js";
import {
  connectMicrosandbox,
  createPreparedMicrosandbox,
  MicrosandboxVm,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
import {
  MICROSANDBOX_DEFAULT_IMAGE,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";

const metadataState = vi.hoisted(() => ({
  writeSessionMetadata: vi.fn(),
}));

vi.mock("#execution/sandbox/bindings/microsandbox-metadata.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#execution/sandbox/bindings/microsandbox-metadata.js")>();
  return {
    ...actual,
    writeSessionMetadata: metadataState.writeSessionMetadata,
  };
});

// The microsandbox native bindings ship for macOS (Apple Silicon) and
// glibc Linux only; keep every microsandbox suite off Windows.
describe.skipIf(process.platform === "win32")("connectMicrosandbox", () => {
  it("persists reconnected session metadata and removes transient state snapshots", async () => {
    const sandbox = createMockMicrosandbox();
    const runtime = createMockMicrosandboxModule(sandbox);
    const metadata: MicrosandboxSessionMetadata = {
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "eve-sbx-ses-old",
      version: 2,
    };

    const vm = expectConnected(
      await connectMicrosandbox({
        metadata,
        metadataPath: "/tmp/eve-microsandbox-session/metadata.json",
        module: runtime.module,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      }),
    );

    await vm.setNetworkPolicy("deny-all");

    expect(metadataState.writeSessionMetadata).toHaveBeenCalledWith(
      "/tmp/eve-microsandbox-session/metadata.json",
      expect.objectContaining({
        networkPolicy: "deny-all",
        optionsHash: "options-hash",
        sandboxName: expect.stringMatching(/^eve-sbx-ses-/u),
        version: 2,
      }),
    );
    expect(runtime.removedSnapshots).toEqual([runtime.createdFromSnapshot]);
  });

  it("captures a durable session snapshot", async () => {
    const sandbox = createMockMicrosandbox();
    const runtime = createMockMicrosandboxModule(sandbox);
    const metadata: MicrosandboxSessionMetadata = {
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "eve-sbx-ses-old",
      version: 2,
    };

    const vm = expectConnected(
      await connectMicrosandbox({
        metadata,
        metadataPath: "/tmp/eve-microsandbox-session/metadata.json",
        module: runtime.module,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      }),
    );

    const captured = await vm.captureState("options-hash");

    expect(captured.stateSnapshotName).toMatch(/^eve-sbx-state-/u);
    expect(metadataState.writeSessionMetadata).toHaveBeenLastCalledWith(
      "/tmp/eve-microsandbox-session/metadata.json",
      expect.objectContaining({
        sandboxName: "eve-sbx-ses-old",
        stateSnapshotName: captured.stateSnapshotName,
      }),
    );
  });

  it("keeps dev sessions live when capturing state", async () => {
    const previousDevFlag = process.env[EVE_DEV_ENV_FLAG];
    process.env[EVE_DEV_ENV_FLAG] = "1";
    const sandbox = createMockMicrosandbox();
    const runtime = createMockMicrosandboxModule(sandbox);
    const metadata: MicrosandboxSessionMetadata = {
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "eve-sbx-ses-old",
      version: 2,
    };

    try {
      const vm = expectConnected(
        await connectMicrosandbox({
          metadata,
          metadataPath: "/tmp/eve-microsandbox-session/metadata.json",
          module: runtime.module,
          options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
          sessionKey: "session-key",
        }),
      );

      const captured = await vm.captureState("options-hash");

      expect(captured.stateSnapshotName).toBeUndefined();
      expect(runtime.createdFromSnapshot).toBe("");
      expect(metadataState.writeSessionMetadata).toHaveBeenLastCalledWith(
        "/tmp/eve-microsandbox-session/metadata.json",
        expect.not.objectContaining({
          stateSnapshotName: expect.any(String),
        }),
      );
    } finally {
      if (previousDevFlag === undefined) {
        delete process.env[EVE_DEV_ENV_FLAG];
      } else {
        process.env[EVE_DEV_ENV_FLAG] = previousDevFlag;
      }
    }
  });

  it("restores stopped sessions from the durable session snapshot", async () => {
    const sandbox = createMockMicrosandbox();
    const runtime = createMockMicrosandboxModule(sandbox, {
      snapshots: ["eve-sbx-state-existing"],
      status: "stopped",
    });
    const metadata: MicrosandboxSessionMetadata = {
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "eve-sbx-ses-old",
      stateSnapshotName: "eve-sbx-state-existing",
      version: 2,
    };

    await connectMicrosandbox({
      metadata,
      metadataPath: "/tmp/eve-microsandbox-session/metadata.json",
      module: runtime.module,
      options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
      sessionKey: "session-key",
    });

    expect(runtime.createdFromSnapshot).toBe("eve-sbx-state-existing");
    expect(metadataState.writeSessionMetadata).toHaveBeenLastCalledWith(
      "/tmp/eve-microsandbox-session/metadata.json",
      expect.objectContaining({
        sandboxName: expect.stringMatching(/^eve-sbx-ses-/u),
        stateSnapshotName: "eve-sbx-state-existing",
      }),
    );
  });

  it("returns null when a stopped session snapshot disappeared", async () => {
    const sandbox = createMockMicrosandbox();
    const runtime = createMockMicrosandboxModule(sandbox, { status: "stopped" });
    const metadata: MicrosandboxSessionMetadata = {
      networkPolicy: "allow-all",
      optionsHash: "options-hash",
      sandboxName: "eve-sbx-ses-old",
      stateSnapshotName: "eve-sbx-state-missing",
      version: 2,
    };

    await expect(
      connectMicrosandbox({
        metadata,
        metadataPath: "/tmp/eve-microsandbox-session/metadata.json",
        module: runtime.module,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      }),
    ).resolves.toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("MicrosandboxVm", () => {
  it("stops the VM before detaching the SDK client on shutdown", async () => {
    const sandbox = {
      detach: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const vm = new MicrosandboxVm(
      {
        module: {} as never,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      },
      sandbox as never,
      "sandbox-name",
      undefined,
    );

    await vm.shutdown();

    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.detach).toHaveBeenCalledTimes(1);
    const stopOrder = sandbox.stop.mock.invocationCallOrder[0];
    const detachOrder = sandbox.detach.mock.invocationCallOrder[0];
    if (stopOrder === undefined || detachOrder === undefined) {
      throw new Error("Expected stop and detach to be called.");
    }
    expect(stopOrder).toBeLessThan(detachOrder);
  });

  it("detaches even when stopping the VM fails on shutdown", async () => {
    const sandbox = {
      detach: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    };
    const vm = new MicrosandboxVm(
      {
        module: {} as never,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      },
      sandbox as never,
      "sandbox-name",
      undefined,
    );

    await expect(vm.shutdown()).resolves.toBeUndefined();
    expect(sandbox.detach).toHaveBeenCalledTimes(1);
  });

  it("finishes streamed commands when the exec handle emits an exit event", async () => {
    const sandbox = {
      async execStreamWith() {
        return createHangingExecHandleAfterExit([
          { data: Buffer.from("file.txt\n"), kind: "stdout" },
          { code: 0, kind: "exited" },
        ]);
      },
    };
    const vm = new MicrosandboxVm(
      {
        module: {} as never,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      },
      sandbox as never,
      "sandbox-name",
      undefined,
    );

    const process = await vm.spawn({ command: "find /workspace -type f" });
    const [stdout, status] = await withTimeout(
      Promise.all([streamToBuffer(process.stdout), process.wait()]),
      250,
    );

    expect(stdout.toString()).toBe("file.txt\n");
    expect(status).toEqual({ exitCode: 0 });
  });

  it("drains streamed command output that arrives immediately after the exit event", async () => {
    const sandbox = {
      async execStreamWith() {
        return createHangingExecHandleAfterExit([
          { code: 0, kind: "exited" },
          { data: Buffer.from("Sat Jun 13 01:00:00 UTC 2026\n"), kind: "stdout" },
        ]);
      },
    };
    const vm = new MicrosandboxVm(
      {
        module: {} as never,
        options: resolveMicrosandboxOptions({ image: MICROSANDBOX_DEFAULT_IMAGE }),
        sessionKey: "session-key",
      },
      sandbox as never,
      "sandbox-name",
      undefined,
    );

    const process = await vm.spawn({ command: "cat /workspace/date.txt" });
    const [stdout, status] = await withTimeout(
      Promise.all([streamToBuffer(process.stdout), process.wait()]),
      250,
    );

    expect(stdout.toString()).toBe("Sat Jun 13 01:00:00 UTC 2026\n");
    expect(status).toEqual({ exitCode: 0 });
  });
});

describe.skipIf(process.platform === "win32")("createPreparedMicrosandbox", () => {
  it("reports the current creation phase while the VM is still starting", async () => {
    vi.useFakeTimers();
    const sandbox = createMockMicrosandbox();
    const created = Promise.withResolvers<typeof sandbox>();
    const log = vi.fn();
    const module = createCreationModule({
      create: () => created.promise,
      progress: [
        { kind: "resolving", reference: MICROSANDBOX_DEFAULT_IMAGE },
        {
          kind: "complete",
          layerCount: 12,
          reference: MICROSANDBOX_DEFAULT_IMAGE,
        },
      ],
    });

    try {
      const pending = createPreparedMicrosandbox({
        log,
        module: module as never,
        name: "template-vm",
        networkPolicy: "deny-all",
        options: resolveMicrosandboxOptions(undefined),
        sessionKey: "template-key",
        setupBaseRuntime: false,
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(log).toHaveBeenCalledWith("image ready; booting microsandbox VM (10s elapsed)");

      created.resolve(sandbox);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds image and provider context when VM creation rejects", async () => {
    class TestMicrosandboxError extends Error {
      readonly code = "imageNotFound";
    }

    const cause = new TestMicrosandboxError("manifest was not found");
    const module = {
      ...createCreationModule({
        create: async () => {
          throw cause;
        },
        progress: [],
      }),
      MicrosandboxError: TestMicrosandboxError,
    };

    const creation = createPreparedMicrosandbox({
      module: module as never,
      name: "template-vm",
      networkPolicy: "deny-all",
      options: resolveMicrosandboxOptions(undefined),
      sessionKey: "template-key",
      setupBaseRuntime: false,
    });

    await expect(creation).rejects.toMatchObject({
      cause,
      message: expect.stringContaining(
        `Failed to create microsandbox VM from image "${MICROSANDBOX_DEFAULT_IMAGE}" ` +
          "while resolving the image [imageNotFound]: manifest was not found. " +
          "Check that the image exists and that the registry credentials can pull it.",
      ),
    });
  });

  it("reports interleaved layer work as one stable phase", async () => {
    const log = vi.fn();
    const module = createCreationModule({
      create: async () => createMockMicrosandbox(),
      progress: [
        { kind: "resolving", reference: MICROSANDBOX_DEFAULT_IMAGE },
        { kind: "layerDownloadProgress" },
        { kind: "layerMaterializeStarted" },
        { kind: "layerDownloadProgress" },
        { kind: "layerMaterializeComplete" },
        { kind: "stitchWritingVmdk" },
        {
          kind: "complete",
          layerCount: 2,
          reference: MICROSANDBOX_DEFAULT_IMAGE,
        },
      ],
    });

    await createPreparedMicrosandbox({
      log,
      module: module as never,
      name: "template-vm",
      networkPolicy: "deny-all",
      options: resolveMicrosandboxOptions(undefined),
      sessionKey: "template-key",
      setupBaseRuntime: false,
    });

    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "resolving the image",
      "downloading and materializing image layers",
      "assembling the image filesystem",
      "image ready; booting microsandbox VM",
    ]);
  });
});

function createMockMicrosandbox() {
  return {
    async stop() {},
  };
}

function createCreationModule(input: {
  readonly create: () => Promise<ReturnType<typeof createMockMicrosandbox>>;
  readonly progress: readonly Record<string, unknown>[];
}) {
  const builder = {
    cpus: returnBuilder,
    async create() {
      return await input.create();
    },
    async createWithPullProgress() {
      return {
        async *[Symbol.asyncIterator]() {
          yield* input.progress;
        },
        awaitSandbox: input.create,
      };
    },
    detached: returnBuilder,
    disableNetwork: returnBuilder,
    envs: returnBuilder,
    image: returnBuilder,
    labels: returnBuilder,
    memory: returnBuilder,
    pullPolicy: returnBuilder,
    replace: returnBuilder,
    user: returnBuilder,
    workdir: returnBuilder,
  };

  function returnBuilder() {
    return builder;
  }

  return {
    Sandbox: {
      builder() {
        return builder;
      },
    },
  };
}

function createHangingExecHandleAfterExit(events: unknown[]) {
  return {
    async kill() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const event = events.shift();
          if (event !== undefined) {
            return { done: false, value: event };
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function expectConnected(vm: MicrosandboxVm | null): MicrosandboxVm {
  if (vm === null) {
    throw new Error("Expected microsandbox reconnect to return a VM.");
  }
  return vm;
}

function createMockMicrosandboxModule(
  sandbox: ReturnType<typeof createMockMicrosandbox>,
  options: { readonly snapshots?: readonly string[]; readonly status?: string } = {},
) {
  let createdFromSnapshot = "";
  const removedSnapshots: string[] = [];
  const oldHandle = {
    status: options.status ?? "running",
    async connectWithTimeout() {
      return sandbox;
    },
    async kill() {},
    async remove() {},
    async snapshot(snapshotName: string) {
      createdFromSnapshot = snapshotName;
    },
    async stopWithTimeout() {},
  };

  const snapshots = new Set(options.snapshots ?? []);
  const module = {
    MicrosandboxError: class extends Error {},
    Sandbox: {
      async get() {
        return oldHandle;
      },
      builder() {
        return createMockSandboxBuilder((fromSnapshot) => {
          createdFromSnapshot = fromSnapshot;
          return createMockMicrosandbox();
        });
      },
    },
    Snapshot: {
      async get(snapshotName: string) {
        if (!snapshots.has(snapshotName)) {
          throw new Error(`snapshot store unavailable for ${snapshotName}`);
        }
        return {};
      },
      async remove(snapshotName: string) {
        removedSnapshots.push(snapshotName);
      },
    },
  };

  return {
    get createdFromSnapshot() {
      return createdFromSnapshot;
    },
    module: module as never,
    removedSnapshots,
  };
}

function createMockSandboxBuilder(create: (fromSnapshot: string) => unknown) {
  let fromSnapshot = "";
  const builder = {
    cpus() {
      return builder;
    },
    detached() {
      return builder;
    },
    disableNetwork() {
      return builder;
    },
    envs() {
      return builder;
    },
    fromSnapshot(nextFromSnapshot: string) {
      fromSnapshot = nextFromSnapshot;
      return builder;
    },
    labels() {
      return builder;
    },
    memory() {
      return builder;
    },
    network(configure: (network: unknown) => unknown) {
      configure(createMockNetworkBuilder());
      return builder;
    },
    pullPolicy() {
      return builder;
    },
    replace() {
      return builder;
    },
    user() {
      return builder;
    },
    workdir() {
      return builder;
    },
    async create() {
      return create(fromSnapshot);
    },
    async createWithPullProgress() {
      return {
        async *[Symbol.asyncIterator]() {},
        async awaitSandbox() {
          return create(fromSnapshot);
        },
      };
    },
  };
  return builder;
}

function createMockNetworkBuilder() {
  const builder = {
    enabled() {
      return builder;
    },
    policyJson() {
      return builder;
    },
    secret(configure: (secret: unknown) => unknown) {
      configure(createMockSecretBuilder());
      return builder;
    },
    trustHostCAs() {
      return builder;
    },
  };
  return builder;
}

function createMockSecretBuilder() {
  const builder = {
    allowAnyHostDangerous() {
      return builder;
    },
    allowHost() {
      return builder;
    },
    allowHostPattern() {
      return builder;
    },
    env() {
      return builder;
    },
    injectBasicAuth() {
      return builder;
    },
    injectBody() {
      return builder;
    },
    injectHeaders() {
      return builder;
    },
    injectQuery() {
      return builder;
    },
    placeholder() {
      return builder;
    },
    requireTlsIdentity() {
      return builder;
    },
    value() {
      return builder;
    },
  };
  return builder;
}
