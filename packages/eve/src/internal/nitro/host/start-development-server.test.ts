import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
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
    files,
    listenerServer,
    mkdir: vi.fn(async () => undefined),
    nitro,
    prepareApplicationHost: vi.fn(async () => ({ appRoot: "/tmp/eve-test" })),
    prepareNitro: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);

      if (value === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }

      return value;
    }),
    rm: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    stat: vi.fn(async (path: string) => {
      if (!files.has(path)) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
    }),
    startDevelopmentSandboxPrewarmInBackground: vi.fn(() => undefined),
    pruneLocalSandboxTemplatesInBackground: vi.fn(() => undefined),
    stopDevelopmentSandboxResources: vi.fn(async () => undefined),
    pruneDevelopmentRuntimeArtifactsSnapshotsInBackground: vi.fn(() => undefined),
    resolveNitroCompiledArtifactsSource: vi.fn(() => ({
      appRoot: "/tmp/eve-test/.eve/dev-runtime-test",
      kind: "disk" as const,
      moduleMapLoaderPath: "/tmp/eve-package/authored-module-map-loader.ts",
    })),
    startAuthoredSourceWatcher: vi.fn(async () => authoredSourceWatcher),
    writeFile: vi.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  rm: mocks.rm,
  stat: mocks.stat,
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

const developmentProcessIdPath = join("/tmp/eve-test", ".eve", "dev-process.pid");
const developmentServerMetadataPath = join("/tmp/eve-test", ".eve", "dev-server.json");

async function startServer(): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const { startDevelopmentServer } =
    await import("#internal/nitro/host/start-development-server.js");

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

describe("startDevelopmentServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it("pins local workflow queue callbacks to the active dev server URL", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
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

  it("uses eve's default port when no port is requested", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
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
    const { startDevelopmentServer } = await import("./start-development-server.js");
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
    const { startDevelopmentServer } = await import("./start-development-server.js");
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

  it("writes the active dev process id and removes it on close", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.files.get(developmentProcessIdPath)).toBe(`${process.pid}\n`);
    expect(JSON.parse(mocks.files.get(developmentServerMetadataPath) ?? "{}")).toMatchObject({
      pid: process.pid,
      url: "http://localhost:2000/",
    });

    await server.close();

    expect(mocks.files.has(developmentProcessIdPath)).toBe(false);
    expect(mocks.files.has(developmentServerMetadataPath)).toBe(false);
  });

  it("refuses to start when the agent already has a running dev process", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    mocks.files.set(developmentProcessIdPath, `${process.pid}\n`);

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow(
      [
        `A dev server is already running for this eve agent (pid ${process.pid}).`,
        "To connect to the existing instance, run: pnpm exec eve dev http://localhost:PORT",
        `To stop it, run: ${
          process.platform === "win32" ? "taskkill /PID" : "kill"
        } ${process.pid}`,
      ].join("\n"),
    );
    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
  });

  it("prints a copyable connect command with the detected package manager and server URL", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    mocks.files.set(
      join("/tmp/eve-test", "package.json"),
      JSON.stringify({ packageManager: "npm@10.0.0" }),
    );
    mocks.files.set(developmentProcessIdPath, `${process.pid}\n`);
    mocks.files.set(
      developmentServerMetadataPath,
      JSON.stringify({
        pid: process.pid,
        updatedAt: "2026-06-17T00:00:00.000Z",
        url: "http://127.0.0.1:4321/",
      }),
    );

    await expect(startDevelopmentServer("/tmp/eve-test")).rejects.toThrow(
      [
        `A dev server is already running for this eve agent (pid ${process.pid}).`,
        "To connect to the existing instance, run: npm exec -- eve dev http://127.0.0.1:4321/",
        `To stop it, run: ${
          process.platform === "win32" ? "taskkill /PID" : "kill"
        } ${process.pid}`,
      ].join("\n"),
    );
    expect(mocks.createApplicationNitro).not.toHaveBeenCalled();
  });

  it("overwrites a stale dev process id", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    mocks.files.set(developmentProcessIdPath, "999999999\n");

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.files.get(developmentProcessIdPath)).toBe(`${process.pid}\n`);

    await server.close();
  });

  it("normalizes wildcard IPv4 listener URLs before exposing them to the REPL or workflow", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    Object.assign(mocks.listenerServer, {
      url: "http://0.0.0.0:2000/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(server.url).toBe("http://127.0.0.1:2000/");
    expect(process.env.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:2000");

    await server.close();
  });

  it("honors the PORT environment variable when no port option is provided", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    process.env.PORT = "4321";
    Object.assign(mocks.listenerServer, {
      url: "http://127.0.0.1:4321/",
    });

    const server = await startDevelopmentServer("/tmp/eve-test");

    expect(mocks.devServer.listen).toHaveBeenCalledWith(expect.objectContaining({ port: 4321 }));

    await server.close();
  });

  it("prefers the explicit port option over the PORT environment variable", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
    process.env.PORT = "4321";

    const server = await startDevelopmentServer("/tmp/eve-test", { port: 5000 });

    expect(mocks.devServer.listen).toHaveBeenCalledWith(expect.objectContaining({ port: 5000 }));

    await server.close();
  });

  it("rejects when the PORT environment variable is not a valid port", async () => {
    const { startDevelopmentServer } = await import("./start-development-server.js");
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
