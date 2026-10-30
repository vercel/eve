import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, UserConfig } from "vite";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import { eveSvelteKit } from "./index.js";

const roots: string[] = [];

async function createTempAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-sveltekit-dev-server-"));
  roots.push(root);
  return root;
}

async function writeRegistry(appRoot: string, registry: Record<string, unknown>): Promise<void> {
  await mkdir(join(appRoot, ".eve"), { recursive: true });
  await writeFile(
    join(appRoot, ".eve", "sveltekit-dev-server.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("eveSvelteKit shared dev servers", () => {
  it("retains each workspace member's target and rewrite after a config reload", async () => {
    vi.stubEnv(EVE_BASE_URL_ENV, undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ revision: "rev-1" })),
    );
    const root = await createTempAppRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "0.0.0" } }));
    const members = [
      { name: "billing", origin: "http://127.0.0.1:49152" },
      { name: "support", origin: "http://127.0.0.1:49153" },
    ];
    for (const { name, origin } of members) {
      const appRoot = join(root, "agents", name);
      await mkdir(join(appRoot, "agent"), { recursive: true });
      await writeFile(join(appRoot, "agent", "agent.ts"), "export default {};\n");
      await writeRegistry(appRoot, {
        appRoot,
        origin,
        pid: null,
        updatedAt: new Date().toISOString(),
      });
    }

    for (let reload = 0; reload < 2; reload++) {
      const plugin = eveSvelteKit();
      if (typeof plugin.config !== "function") throw new Error("expected plugin config hook");
      const configure = plugin.config as (
        config: UserConfig,
        env: ConfigEnv,
      ) => Promise<UserConfig>;
      const config = await configure({ root }, { command: "serve", mode: "development" });
      for (const { name, origin } of members) {
        const proxy = config.server?.proxy?.[`/eve/${name}/v1`];
        expect(proxy).toMatchObject({ target: origin, changeOrigin: true });
        expect(typeof proxy === "object" && proxy.rewrite?.(`/eve/${name}/v1/chat?stream=1`)).toBe(
          "/eve/v1/chat?stream=1",
        );
      }
    }
  });

  it("reuses a ready registered server without changing an explicit origin override", async () => {
    vi.stubEnv(EVE_BASE_URL_ENV, "https://agents.example.com");
    const appRoot = await createTempAppRoot();
    const fetchMock = vi.fn(async () => Response.json({ revision: "rev-1" }));
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
    expect(process.env[EVE_BASE_URL_ENV]).toBe("https://agents.example.com");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/eve/v1/dev/runtime-artifacts", "http://127.0.0.1:49152"),
      { redirect: "error", signal: expect.any(AbortSignal) },
    );
  });
});
