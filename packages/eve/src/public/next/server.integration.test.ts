import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { resolveEveDestinationPrefix } from "./server.js";

const tempRoots: string[] = [];

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill(): void;
  pid: number;
}

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 12345;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
  };
  return child;
}

describe("resolveEveDestinationPrefix", () => {
  afterEach(async () => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        rm(root, {
          force: true,
          recursive: true,
        }),
      ),
    );
  });

  it("ignores non-server URLs in dev server output while waiting for the listening URL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess();
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    spawnMock.mockReturnValue(child);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ revision: "test", serverId: "server-1" }),
    );

    const destination = resolveEveDestinationPrefix({
      appRoot,
      logLabel: "support",
      phase: "phase-development-server",
      productionDestinationPrefix: "/internal/eve",
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    child.stdout.emit(
      "data",
      Buffer.from('dependency metadata: "homepage": "https://rolldown.rs/"\n'),
    );
    child.stdout.emit("data", Buffer.from("docs: open http://localhost for details\n"));
    child.stderr.emit("data", Buffer.from("dev server listening at http://127.0.0.1:33449\n"));

    await expect(destination).resolves.toBe("http://127.0.0.1:33449");
    await expect(readRegisteredServer(appRoot)).resolves.toEqual({
      origin: "http://127.0.0.1:33449",
      serverId: "server-1",
    });
    expect(stdoutWrites).toContain(
      '[eve:dev:support] dependency metadata: "homepage": "https://rolldown.rs/"\n',
    );
    expect(stderrWrites).toContain(
      "[eve:dev:support] server listening at http://127.0.0.1:33449\n",
    );
  });

  it("suppresses low-signal eve dev startup output", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    spawnMock.mockReturnValue(child);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ revision: "test", serverId: "server-1" }),
    );

    const destination = resolveEveDestinationPrefix({
      appRoot,
      logLabel: "billing",
      phase: "phase-development-server",
      productionDestinationPrefix: "/internal/eve",
    });

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
    child.stdout.emit(
      "data",
      Buffer.from(
        "☰eve  v0.0.0\nCONFIGURATION_FIELD_CONFLICT\n\u001b[33m[CONFIGURATION_FIELD_CONFLICT] \u001b[0mnoisy\n[dev] server listening at http://127.0.0.1:33450\n",
      ),
    );

    await expect(destination).resolves.toBe("http://127.0.0.1:33450");
    expect(stdoutWrites).toEqual([
      "[eve:dev:billing] server listening at http://127.0.0.1:33450\n",
    ]);
  });

  it("stops a spawned server that never exposes its development identity", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revision: "test" }));

    const destination = resolveEveDestinationPrefix({
      appRoot,
      devServerTimeoutMs: 250,
      phase: "phase-development-server",
      productionDestinationPrefix: "/internal/eve",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.stdout.emit("data", Buffer.from("server listening at http://127.0.0.1:33451\n"));

    await expect(destination).rejects.toThrow("eve dev server did not become ready");
    expect(child.killed).toBe(true);
  });
});

async function createTempAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-next-server-"));
  tempRoots.push(root);
  return root;
}

async function readRegisteredServer(
  appRoot: string,
): Promise<{ readonly origin: string; readonly serverId: string }> {
  const registry = JSON.parse(
    await readFile(join(appRoot, ".eve", "next-dev-server.json"), "utf8"),
  ) as { readonly origin?: unknown; readonly serverId?: unknown };
  if (typeof registry.origin !== "string" || typeof registry.serverId !== "string") {
    throw new Error("eve dev server registry did not record its origin and identity.");
  }
  return { origin: registry.origin, serverId: registry.serverId };
}
