import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";

async function createTempAppRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-sveltekit-dev-server-"));
}

async function writeRegistry(appRoot: string, registry: Record<string, unknown>): Promise<void> {
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(
    join(appRoot, ".eve", "sveltekit-dev-server.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

afterEach(() => {
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
});
