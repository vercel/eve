import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("resolveSharedEveDevServer", () => {
  it("reuses a ready server registered by another process instead of spawning", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-framework-dev-server-"));
    tempRoots.push(appRoot);
    const fetchMock = vi.fn(async () => Response.json({ revision: "rev-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await mkdir(join(appRoot, ".eve"), { recursive: true });
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
