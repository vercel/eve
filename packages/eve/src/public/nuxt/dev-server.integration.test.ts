import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";

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

async function createTempAppRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-nuxt-dev-server-"));
}

async function writeRegistry(appRoot: string, registry: Record<string, unknown>): Promise<void> {
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(
    join(appRoot, ".eve", "nuxt-dev-server.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete process.env[EVE_BASE_URL_ENV];
});

describe("resolveSharedEveDevServer", () => {
  it("reuses a healthy registered server instead of spawning", async () => {
    const appRoot = await createTempAppRoot();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await writeRegistry(appRoot, {
      appRoot,
      origin: "http://127.0.0.1:49152",
      pid: null,
      updatedAt: new Date().toISOString(),
    });

    const handle = await resolveSharedEveDevServer(appRoot);

    expect(handle).toEqual({ origin: "http://127.0.0.1:49152" });
    expect(handle.process).toBeUndefined();
    expect(process.env[EVE_BASE_URL_ENV]).toBe("http://127.0.0.1:49152");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49152/eve/v1/health", {
      signal: expect.any(AbortSignal),
    });
  });

  it("ignores non-server URLs in eve output while waiting for the listening URL", async () => {
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    spawnMock.mockReturnValue(child);

    const handle = resolveSharedEveDevServer(appRoot);

    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    child.stdout.emit(
      "data",
      Buffer.from('dependency metadata: "homepage": "https://rolldown.rs/"\n'),
    );
    child.stdout.emit("data", Buffer.from("docs: open http://localhost for details\n"));
    child.stderr.emit("data", Buffer.from("dev server listening at http://127.0.0.1:33449\n"));

    await expect(handle).resolves.toMatchObject({ origin: "http://127.0.0.1:33449" });
    expect(process.env[EVE_BASE_URL_ENV]).toBe("http://127.0.0.1:33449");
    expect(stdoutWrites).toContain('dependency metadata: "homepage": "https://rolldown.rs/"\n');
  });
});
