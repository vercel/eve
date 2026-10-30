import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { resolveSharedEveDevServer } from "./framework-eve-server.js";

const tempRoots: string[] = [];

afterEach(async () => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-framework-dev-server-"));
  tempRoots.push(appRoot);
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  return appRoot;
}

const host = { label: "SvelteKit", slug: "sveltekit" };

async function writeOldLock(appRoot: string, owner: string): Promise<string> {
  const lockPath = join(appRoot, ".eve", "sveltekit-dev-server.lock");
  await writeFile(lockPath, owner);
  const oldTime = new Date(Date.now() - 31_000);
  await utimes(lockPath, oldTime, oldTime);
  return lockPath;
}

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    killed: false,
    pid: 12345,
  });
  spawnMock.mockReturnValue(child);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return child;
}

describe("resolveSharedEveDevServer", () => {
  it.each(["running", "permission denied"])(
    "keeps an old startup lock when its owner is %s",
    async (state) => {
      const appRoot = await createAppRoot();
      const child = mockChild();
      const startup = resolveSharedEveDevServer({ appRoot, host });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      const owner = `${process.pid}\n`;
      const lockPath = await writeOldLock(appRoot, owner);
      if (state === "permission denied") {
        vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        });
      }
      spawnMock.mockImplementation(() => {
        throw new Error("started a duplicate eve process");
      });

      try {
        await expect(resolveSharedEveDevServer({ appRoot, host, timeoutMs: 1 })).rejects.toThrow(
          "waiting for another SvelteKit process to start eve",
        );

        expect(spawnMock).toHaveBeenCalledTimes(1);
        await expect(readFile(lockPath, "utf8")).resolves.toBe(owner);
      } finally {
        child.stdout.emit("data", Buffer.from("server listening at http://127.0.0.1:49152\n"));
        await startup;
      }
    },
  );

  it("recovers an old startup lock whose owner has exited", async () => {
    const appRoot = await createAppRoot();
    await writeOldLock(appRoot, "123456789\n");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const child = mockChild();

    const startup = resolveSharedEveDevServer({ appRoot, host });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    child.stdout.emit("data", Buffer.from("server listening at http://127.0.0.1:49152\n"));

    await expect(startup).resolves.toMatchObject({ origin: "http://127.0.0.1:49152" });
    await expect(
      readFile(join(appRoot, ".eve", "sveltekit-dev-server.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not release a replacement lock after startup", async () => {
    const appRoot = await createAppRoot();
    const lockPath = join(appRoot, ".eve", "sveltekit-dev-server.lock");
    const child = mockChild();

    const startup = resolveSharedEveDevServer({ appRoot, host });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await rm(lockPath);
    await writeFile(lockPath, "another owner\n");
    child.stdout.emit("data", Buffer.from("server listening at http://127.0.0.1:49152\n"));

    await expect(startup).resolves.toMatchObject({ origin: "http://127.0.0.1:49152" });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("another owner\n");
  });

  it("reuses a ready server registered by another process instead of spawning", async () => {
    const appRoot = await createAppRoot();
    const fetchMock = vi.fn(async () => Response.json({ revision: "rev-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await writeFile(
      join(appRoot, ".eve", "nuxt-dev-server.json"),
      JSON.stringify({
        appRoot,
        origin: "http://127.0.0.1:49152",
        pid: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    const handle = await resolveSharedEveDevServer({
      appRoot,
      host: { label: "Nuxt", slug: "nuxt" },
    });

    expect(handle).toEqual({ origin: "http://127.0.0.1:49152" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/eve/v1/dev/runtime-artifacts", "http://127.0.0.1:49152"),
      { redirect: "error", signal: expect.any(AbortSignal) },
    );
  });
});
