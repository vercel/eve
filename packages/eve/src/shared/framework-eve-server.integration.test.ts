import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

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

async function createRegisteredApp(input: { recordId: string }): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-framework-dev-server-"));
  tempRoots.push(appRoot);
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
  await new DevelopmentServerState({ appRoot }).write({
    url: "http://127.0.0.1:49152/",
    pid: process.pid,
    id: input.recordId,
  });
  return appRoot;
}

describe("resolveSharedEveDevServer", () => {
  it("reuses a registered server whose id matches the app's own record instead of spawning", async () => {
    const appRoot = await createRegisteredApp({ recordId: "server-a" });
    const fetchMock = vi.fn(async () => Response.json({ revision: "rev-1", serverId: "server-a" }));
    vi.stubGlobal("fetch", fetchMock);

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

  it("does not reuse a registered origin that another app's eve server now holds", async () => {
    const appRoot = await createRegisteredApp({ recordId: "server-a" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ revision: "rev-1", serverId: "server-of-another-app" })),
    );

    await expect(
      resolveSharedEveDevServer({ appRoot, host: { label: "Nuxt", slug: "nuxt" } }),
    ).rejects.toThrow();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
