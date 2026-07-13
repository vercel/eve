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
    await expect(readRegisteredOrigin(appRoot)).resolves.toBe("http://127.0.0.1:33449");
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
});

async function createTempAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-next-server-"));
  tempRoots.push(root);
  return root;
}

async function readRegisteredOrigin(appRoot: string): Promise<string> {
  const registry = JSON.parse(
    await readFile(join(appRoot, ".eve", "next-dev-server.json"), "utf8"),
  ) as { readonly origin?: unknown };
  if (typeof registry.origin !== "string") {
    throw new Error("eve dev server registry did not record a string origin.");
  }
  return registry.origin;
}
