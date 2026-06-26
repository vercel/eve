import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DevelopmentServerHandle,
  DevelopmentServerOptions,
} from "#internal/nitro/host/types.js";

const mocks = vi.hoisted(() => {
  const fsControl: {
    stateReadError?: Error;
    stateWriteError?: Error;
  } = {};
  const authoredSourceWatcher = {
    close: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  };
  const listenerServer = {
    close: vi.fn(async () => undefined),
    ready: vi.fn(async () => undefined),
    url: "http://localhost:2000/",
  };
  const devServer = {
    close: vi.fn(async () => undefined),
    listen: vi.fn(() => listenerServer),
    upgrade: vi.fn(async (_req: unknown, _socket: unknown, _head: unknown) => undefined),
  };
  const files = new Map<string, string>();
  const nitro = {
    close: vi.fn(async () => undefined),
    options: {
      buildDir: "/tmp/eve-test/.eve/nitro",
      devServer: {
        hostname: "127.0.0.1",
        port: 0,
      },
      experimental: {},
      features: {},
    },
  };

  return {
    authoredSourceWatcher,
    buildNitro: vi.fn(async () => undefined),
    createApplicationNitro: vi.fn(async () => nitro),
    createDevServer: vi.fn(() => devServer),
    devServer,
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    files,
    fsControl,
    listenerServer,
    mkdir: vi.fn(async () => undefined),
    nitro,
    prepareApplicationHost: vi.fn(async () => ({ appRoot: "/tmp/eve-test" })),
    prepareNitro: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      if (
        path.endsWith("/.eve/dev-server-state.v1.json") &&
        fsControl.stateReadError !== undefined
      ) {
        throw fsControl.stateReadError;
      }

      const value = files.get(path);

      if (value === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      return value;
    }),
    rm: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    startDevelopmentSandboxPrewarmInBackground: vi.fn(() => undefined),
    pruneLocalSandboxTemplatesInBackground: vi.fn(() => undefined),
    stopDevelopmentSandboxResources: vi.fn(async () => undefined),
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground: vi.fn(() => undefined),
    resolveDiscoveryProject: vi.fn(async () => ({
      agentRoot: "/tmp/eve-test/agent",
      appRoot: "/tmp/eve-test",
      layout: "nested" as const,
    })),
    resolveNitroCompiledArtifactsSource: vi.fn(() => ({
      appRoot: "/tmp/eve-test/.eve/dev-runtime-test",
      kind: "disk" as const,
      moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
    })),
    startAuthoredSourceWatcher: vi.fn(async () => authoredSourceWatcher),
    writeFile: vi.fn(async (path: string, value: string) => {
      if (
        path.endsWith("/.eve/dev-server-state.v1.json") &&
        fsControl.stateWriteError !== undefined
      ) {
        throw fsControl.stateWriteError;
      }
      files.set(path, value);
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));

vi.mock("nitro/builder", () => ({
  build: mocks.buildNitro,
  createDevServer: mocks.createDevServer,
  prepare: mocks.prepareNitro,
}));

vi.mock("./create-application-nitro.js", () => ({
  createApplicationNitro: mocks.createApplicationNitro,
}));

vi.mock("./dev-authored-source-watcher.js", () => ({
  startAuthoredSourceWatcher: mocks.startAuthoredSourceWatcher,
}));

vi.mock("./prepare-application-host.js", () => ({
  prepareApplicationHost: mocks.prepareApplicationHost,
}));

vi.mock("#discover/project.js", () => ({
  resolveDiscoveryProject: mocks.resolveDiscoveryProject,
}));

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: mocks.resolveNitroCompiledArtifactsSource,
}));

vi.mock("#execution/sandbox/development-prewarm.js", () => ({
  startDevelopmentSandboxPrewarmInBackground: mocks.startDevelopmentSandboxPrewarmInBackground,
}));

vi.mock("#execution/sandbox/bindings/local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/sandbox/bindings/local.js")>();

  return {
    ...actual,
    pruneLocalSandboxTemplatesInBackground: mocks.pruneLocalSandboxTemplatesInBackground,
    stopDevelopmentSandboxResources: mocks.stopDevelopmentSandboxResources,
  };
});

vi.mock("#internal/nitro/dev-runtime-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/nitro/dev-runtime-artifacts.js")>();

  return {
    ...actual,
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground:
      mocks.pruneDevelopmentRuntimeArtifactsSnapshotsInBackground,
  };
});

function createRequest(): IncomingMessage {
  return {
    headers: {
      upgrade: "websocket",
    },
    method: "GET",
  } as IncomingMessage;
}

function createSocket(): Socket {
  const socket = new EventEmitter() as Socket;
  Object.defineProperty(socket, "destroyed", {
    configurable: true,
    value: false,
  });
  socket.destroy = vi.fn(() => {
    Object.defineProperty(socket, "destroyed", {
      configurable: true,
      value: true,
    });
    return socket;
  });
  return socket;
}

const developmentServerStatePath = join("/tmp/eve-test", ".eve", "dev-server-state.v1.json");

function readStateRecord(
  path: string = developmentServerStatePath,
): Record<string, unknown> | undefined {
  const raw = mocks.files.get(path);
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
}

function seedStateRecord(
  record: Record<string, unknown>,
  path: string = developmentServerStatePath,
): void {
  mocks.files.set(path, `${JSON.stringify(record)}\n`);
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    reject(error) {
      if (rejectPromise === undefined) {
        throw new Error("Deferred promise was not initialized.");
      }
      rejectPromise(error);
    },
    resolve(value) {
      if (resolvePromise === undefined) {
        throw new Error("Deferred promise was not initialized.");
      }
      resolvePromise(value);
    },
  };
}

/** The owned-server shape the suite asserted against before `close()` moved onto `DevelopmentServer`. */
type StartedTestServer = DevelopmentServerHandle & { close(): Promise<void> };

/**
 * Adapts `createDevelopmentServer().start()` back into the handle-plus-`close()`
 * shape these tests assert against, so each call exercises the real factory,
 * `start()`, and `close()` while keeping the call sites terse.
 */
async function loadStartDevelopmentServer(): Promise<
  (rootDir: string, options?: DevelopmentServerOptions) => Promise<StartedTestServer>
> {
  const { createDevelopmentServer } =
    await import("#internal/nitro/host/start-development-server.js");

  return async (rootDir, options) => {
    const server = createDevelopmentServer(rootDir, options);
    const handle = await server.start();
    return Object.assign({ ...handle }, { close: () => server.close() });
  };
}

async function startServer(): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const startDevelopmentServer = await loadStartDevelopmentServer();

  return await startDevelopmentServer("/tmp/eve-test");
}

describe("normalizeDevelopmentServerClientUrl", () => {
  it("rewrites the IPv6 wildcard listen hostname to IPv6 loopback", async () => {
    const { normalizeDevelopmentServerClientUrl } = await import("./start-development-server.js");

    expect(normalizeDevelopmentServerClientUrl("http://[::]:3000/")).toBe("http://[::1]:3000/");
  });

  it("rewrites the IPv4 wildcard listen hostname to a loopback address", async () => {
    const { normalizeDevelopmentServerClientUrl } = await import("./start-development-server.js");

    expect(normalizeDevelopmentServerClientUrl("http://0.0.0.0:3000/")).toBe(
      "http://127.0.0.1:3000/",
    );
  });

  it("leaves a routable hostname untouched", async () => {
    const { normalizeDevelopmentServerClientUrl } = await import("./start-development-server.js");

    expect(normalizeDevelopmentServerClientUrl("http://127.0.0.1:42123/")).toBe(
      "http://127.0.0.1:42123/",
    );
    expect(normalizeDevelopmentServerClientUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/",
    );
  });
});

describe("createDevelopmentServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(new Response(null, { status: 200 }));
    mocks.fsControl.stateReadError = undefined;
    mocks.fsControl.stateWriteError = undefined;
    mocks.authoredSourceWatcher.close.mockResolvedValue(undefined);
    mocks.devServer.close.mockResolvedValue(undefined);
    mocks.nitro.close.mockResolvedValue(undefined);
    mocks.stopDevelopmentSandboxResources.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mocks.fetch);
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    delete process.env.PORT;
    delete process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID;
    mocks.files.clear();
    mocks.devServer.upgrade = vi.fn(
      async (_req: unknown, _socket: unknown, _head: unknown) => undefined,
    );
    Object.assign(mocks.nitro.options, {
      experimental: {},
      features: {},
    });
    Object.assign(mocks.nitro.options.devServer, {
      hostname: "127.0.0.1",
      port: undefined,
    });
    Object.assign(mocks.listenerServer, {
      url: "http://localhost:2000/",
    });
  });

  afterEach(() => {
    delete process.env.WORKFLOW_LOCAL_BASE_URL;
    delete process.env.PORT;
    delete process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID;
    mocks.files.clear();
    vi.unstubAllGlobals();
  });

  it("pins local workflow queue callbacks to the active dev server URL", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    Object.assign(mocks.listenerServer, {
      url: "http://127.0.0.1:42123/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.prepareApplicationHost).toHaveBeenCalledWith("/tmp/eve-test", { dev: true });
    expect(mocks.pruneDevelopmentRuntimeArtifactsSnapshotsInBackground).toHaveBeenCalledWith(
      "/tmp/eve-test",
    );
    expect(mocks.startDevelopmentSandboxPrewarmInBackground).toHaveBeenCalledWith({
      appRoot: "/tmp/eve-test",
      compiledArtifactsSource: {
        appRoot: "/tmp/eve-test/.eve/dev-runtime-test",
        kind: "disk",
        moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
      },
    });
    expect(mocks.pruneLocalSandboxTemplatesInBackground).toHaveBeenCalledWith("/tmp/eve-test");
    expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:42123");
    expect(process.env.PORT).toBe("42123");

    await server.close();

    expect(mocks.stopDevelopmentSandboxResources).toHaveBeenCalledWith({
      backendNames: [],
      devRunId: expect.any(String),
      log: expect.any(Function),
    });
    expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBeUndefined();
    expect(process.env.PORT).toBeUndefined();
    expect(process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID).toBeUndefined();
  });

  it("uses Eve's default port when no port is requested", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    Object.assign(mocks.nitro.options.devServer, {
      port: 3000,
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.devServer.listen).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 2000,
      silent: true,
    });

    await server.close();
  });

  it("normalizes wildcard IPv6 listener URLs before exposing them to the REPL or workflow", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    Object.assign(mocks.listenerServer, {
      url: "http://[::]:2000/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(server.url).toBe("http://[::1]:2000/");
    expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe("http://[::1]:2000");
    expect(process.env.PORT).toBe("2000");

    await server.close();
  });

  it("retries the next port on IPv4 loopback when the default port is occupied", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    const addressInUseError = Object.assign(new Error("Address already in use"), {
      code: "EADDRINUSE",
    });
    Object.assign(mocks.nitro.options.devServer, {
      hostname: undefined,
    });
    Object.assign(mocks.listenerServer, {
      url: "http://127.0.0.1:2001/",
    });
    mocks.listenerServer.ready
      .mockRejectedValueOnce(addressInUseError)
      .mockResolvedValueOnce(undefined);

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.devServer.listen).toHaveBeenNthCalledWith(1, {
      hostname: "127.0.0.1",
      port: 2000,
      silent: true,
    });
    expect(mocks.devServer.listen).toHaveBeenNthCalledWith(2, {
      hostname: "127.0.0.1",
      port: 2001,
      silent: true,
    });
    expect(server.url).toBe("http://127.0.0.1:2001/");

    await server.close();
  });

  it("records the active dev server URL and removes the state on close", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();

    const server = await startDevelopmentServer("/tmp/eve-test");

    const record = readStateRecord();
    expect(record).toEqual({ url: "http://localhost:2000/" });

    await server.close();

    expect(mocks.files.has(developmentServerStatePath)).toBe(false);
  });

  it("attempts every cleanup step when the authored-source watcher fails to close", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    const server = await startDevelopmentServer("/tmp/eve-test");
    mocks.authoredSourceWatcher.close.mockRejectedValueOnce(new Error("watcher close failed"));

    await expect(server.close()).rejects.toThrow("watcher close failed");

    expect(mocks.devServer.close).toHaveBeenCalledOnce();
    expect(mocks.nitro.close).toHaveBeenCalledOnce();
    expect(mocks.stopDevelopmentSandboxResources).toHaveBeenCalledOnce();
    expect(readStateRecord()).toBeUndefined();
  });

  it("keeps the state record when the listener fails to close", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    const server = await startDevelopmentServer("/tmp/eve-test");
    mocks.devServer.close.mockRejectedValueOnce(new Error("listener close failed"));

    await expect(server.close()).rejects.toThrow("listener close failed");

    expect(mocks.nitro.close).toHaveBeenCalledOnce();
    expect(mocks.stopDevelopmentSandboxResources).toHaveBeenCalledOnce();
    expect(readStateRecord()).toEqual({ url: "http://localhost:2000/" });
  });

  it("closes the server when its state record cannot be written", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    mocks.fsControl.stateWriteError = Object.assign(new Error("disk full"), { code: "ENOSPC" });

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow("disk full");

    expect(mocks.devServer.close).toHaveBeenCalledOnce();
    expect(mocks.nitro.close).toHaveBeenCalledOnce();
    expect(readStateRecord()).toBeUndefined();
  });

  it("does not start when the state record cannot be read", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    mocks.fsControl.stateReadError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow("permission denied");

    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
  });

  it("reports a healthy recorded server when starting another server", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    seedStateRecord({ url: "http://localhost:2000/" });

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow(
      [
        "A dev server is already running for this eve agent.",
        "To connect to the existing instance, run: pnpm exec eve dev http://localhost:2000/",
      ].join("\n"),
    );
    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
  });

  it("reuses the active server recorded for the same app root when requested", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();

    const owner = await startDevelopmentServer("/tmp/eve-test");
    const ownerSandboxRunId = process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID;
    // A real attaching TUI is a separate process and does not inherit the
    // owner's internally installed listener port.
    delete process.env.PORT;
    const attached = await startDevelopmentServer("/tmp/eve-test", {
      existing: "attach-if-unconfigured",
    });

    expect(attached.kind).toBe("existing");
    expect(attached.url).toBe(owner.url);
    expect(mocks.createApplicationNitro).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith("http://localhost:2000/eve/v1/health", {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID).toBe(ownerSandboxRunId);

    expect(mocks.devServer.close).not.toHaveBeenCalled();
    expect(process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID).toBe(ownerSandboxRunId);
    expect(readStateRecord()).toEqual({ url: "http://localhost:2000/" });

    await owner.close();
    expect(process.env.EVE_DEVELOPMENT_SANDBOX_RUN_ID).toBeUndefined();
  });

  it("close() tears nothing down when the instance attached to an existing owner", async () => {
    const { createDevelopmentServer } = await import("./start-development-server.js");

    const owner = createDevelopmentServer("/tmp/eve-test");
    await owner.start();
    // A real attaching TUI is a separate process and does not inherit the
    // owner's internally installed listener port.
    delete process.env.PORT;

    const attaching = createDevelopmentServer("/tmp/eve-test", {
      existing: "attach-if-unconfigured",
    });
    const attached = await attaching.start();
    expect(attached.kind).toBe("existing");

    mocks.devServer.close.mockClear();
    await attaching.close();
    // The attaching instance owns nothing, so close() is a no-op: it neither
    // closes the listener nor disturbs the owner's published state.
    expect(mocks.devServer.close).not.toHaveBeenCalled();
    expect(readStateRecord()).toEqual({ url: "http://localhost:2000/" });

    await owner.close();
  });

  it("waits for a pending start before closing an owned server", async () => {
    const { createDevelopmentServer } = await import("./start-development-server.js");
    const project = createDeferred<{
      readonly agentRoot: string;
      readonly appRoot: string;
      readonly layout: "nested";
    }>();
    mocks.resolveDiscoveryProject.mockReturnValueOnce(project.promise);

    const server = createDevelopmentServer("/tmp/eve-test");
    const starting = server.start();
    await vi.waitFor(() => expect(mocks.resolveDiscoveryProject).toHaveBeenCalledOnce());
    const closing = server.close();

    project.resolve({
      agentRoot: "/tmp/eve-test/agent",
      appRoot: "/tmp/eve-test",
      layout: "nested",
    });

    await starting;
    await closing;

    expect(mocks.devServer.close).toHaveBeenCalledOnce();
    expect(readStateRecord()).toBeUndefined();
  });

  it("waits for a failed start without rethrowing from close", async () => {
    const { createDevelopmentServer } = await import("./start-development-server.js");
    const project = createDeferred<{
      readonly agentRoot: string;
      readonly appRoot: string;
      readonly layout: "nested";
    }>();
    mocks.resolveDiscoveryProject.mockReturnValueOnce(project.promise);

    const server = createDevelopmentServer("/tmp/eve-test");
    const starting = server.start();
    await vi.waitFor(() => expect(mocks.resolveDiscoveryProject).toHaveBeenCalledOnce());
    const closing = server.close();

    project.reject(new Error("discovery failed"));

    await expect(starting).rejects.toThrow("discovery failed");
    await expect(closing).resolves.toBeUndefined();
    expect(mocks.devServer.close).not.toHaveBeenCalled();
  });

  it("does not attach when PORT explicitly configures the endpoint", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    process.env.PORT = "2000";
    seedStateRecord({ url: "http://localhost:2000/" });

    await expect(
      startDevelopmentServer("/tmp/eve-test", { existing: "attach-if-unconfigured" }),
    ).rejects.toThrow("A dev server is already running for this eve agent.");
    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("rejects reuse when the requested environment port conflicts", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    process.env.PORT = "2001";
    seedStateRecord({ url: "http://localhost:2000/" });

    await expect(
      startDevelopmentServer("/tmp/eve-test", { existing: "attach-if-unconfigured" }),
    ).rejects.toThrow("A dev server is already running for this eve agent.");
    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("overwrites an unhealthy state record", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    seedStateRecord({ url: "http://localhost:2000/" });

    const server = await startDevelopmentServer("/tmp/eve-test", {
      existing: "attach-if-unconfigured",
    });

    expect(mocks.fetch).toHaveBeenCalledWith("http://localhost:2000/eve/v1/health", {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.createApplicationNitro).toHaveBeenCalledOnce();
    expect(readStateRecord()).toEqual({ url: "http://localhost:2000/" });

    await server.close();
  });

  it("does not probe a non-loopback URL from persisted state", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    seedStateRecord({ url: "http://192.168.1.20:2000/" });

    const server = await startDevelopmentServer("/tmp/eve-test", {
      existing: "attach-if-unconfigured",
    });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.createApplicationNitro).toHaveBeenCalledOnce();

    await server.close();
  });

  it("does not reuse a server recorded under another app root", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    const otherAppRoot = "/tmp/other-eve-test";

    seedStateRecord(
      { url: "http://127.0.0.1:2999/" },
      join(otherAppRoot, ".eve", "dev-server-state.v1.json"),
    );

    const server = await startDevelopmentServer("/tmp/eve-test", {
      existing: "attach-if-unconfigured",
    });

    expect(server.url).toBe("http://localhost:2000/");
    expect(mocks.createApplicationNitro).toHaveBeenCalledOnce();

    if (server.kind !== "started") {
      throw new Error("Expected to start the server for the requested app root.");
    }
    await server.close();
  });

  it("overwrites a stale dev server record", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    seedStateRecord({ url: "http://localhost:2000/" });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(readStateRecord()).toEqual({ url: "http://localhost:2000/" });

    await server.close();
  });

  it("normalizes wildcard IPv4 listener URLs before exposing them to the REPL or workflow", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    Object.assign(mocks.listenerServer, {
      url: "http://0.0.0.0:2000/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(server.url).toBe("http://127.0.0.1:2000/");
    expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:2000");

    await server.close();
  });

  it("honors the PORT environment variable when no port option is provided", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    process.env.PORT = "4321";
    Object.assign(mocks.listenerServer, {
      url: "http://127.0.0.1:4321/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.devServer.listen).toHaveBeenCalledWith(expect.objectContaining({ port: 4321 }));

    await server.close();
  });

  it("prefers the explicit port option over the PORT environment variable", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    process.env.PORT = "4321";

    const server = await startDevelopmentServer("/tmp/eve-test", { port: 5000 });

    expect(mocks.devServer.listen).toHaveBeenCalledWith(expect.objectContaining({ port: 5000 }));

    await server.close();
  });

  it("rejects when the PORT environment variable is not a valid port", async () => {
    const startDevelopmentServer = await loadStartDevelopmentServer();
    process.env.PORT = "not-a-port";

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow(
      /Invalid PORT environment variable/,
    );
  });

  it("swallows websocket upgrade rejections from the Nitro dev server", async () => {
    const originalUpgrade = vi.fn(
      async (_req: unknown, _socket: unknown, _head: unknown): Promise<undefined> => {
        throw new Error("Upstream server did not upgrade the connection");
      },
    );
    Object.assign(mocks.nitro.options.features, { websocket: true });
    mocks.devServer.upgrade = originalUpgrade;

    const server = await startServer();

    try {
      const socket = createSocket();
      await expect(
        mocks.devServer.upgrade(createRequest(), socket, Buffer.alloc(0)),
      ).resolves.toBeUndefined();

      expect(originalUpgrade).toHaveBeenCalledTimes(1);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("rejects websocket upgrades before Nitro proxying when websocket support is disabled", async () => {
    const originalUpgrade = vi.fn(
      async (_req: unknown, _socket: unknown, _head: unknown): Promise<undefined> => undefined,
    );
    mocks.devServer.upgrade = originalUpgrade;

    const server = await startServer();

    try {
      const socket = createSocket();
      await expect(
        mocks.devServer.upgrade(createRequest(), socket, Buffer.alloc(0)),
      ).resolves.toBeUndefined();

      expect(originalUpgrade).not.toHaveBeenCalled();
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("handles socket errors emitted during websocket upgrade handling", async () => {
    const originalUpgrade = vi.fn(
      async (_req: unknown, socket: unknown, _head: unknown): Promise<undefined> => {
        const upgradeSocket = socket as Socket;

        upgradeSocket.emit("error", new Error("socket failure"));
        throw new Error("socket failure");
      },
    );
    Object.assign(mocks.nitro.options.features, { websocket: true });
    mocks.devServer.upgrade = originalUpgrade;

    const server = await startServer();

    try {
      const socket = createSocket();
      await expect(
        mocks.devServer.upgrade(createRequest(), socket, Buffer.alloc(0)),
      ).resolves.toBeUndefined();

      expect(originalUpgrade).toHaveBeenCalledTimes(1);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
