import { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
  type VercelBuildConfig,
} from "#shared/vercel-services.js";

import { eveTanStack } from "./index.js";

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("#shared/vercel-services.js", () => ({
  ensureEveVercelServicesConfig: vi.fn(async () => ({ mode: "root" })),
  mergeEveVercelConfig: vi.fn(() => ({ routes: [], services: {}, version: 3 })),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const ensureEveVercelServicesConfigMock = vi.mocked(ensureEveVercelServicesConfig);
const mergeEveVercelConfigMock = vi.mocked(mergeEveVercelConfig);

type ConfigHook = (config: UserConfig, env: ConfigEnv) => Promise<unknown>;
type NitroOptions = { vercel?: { config?: VercelBuildConfig; [key: string]: unknown } };
type EveTanStackPlugin = Plugin & {
  nitro: { setup(nitro: { options: NitroOptions }): Promise<void> };
};

const serveEnv: ConfigEnv = { command: "serve", mode: "development" };
const buildEnv: ConfigEnv = { command: "build", mode: "production" };

function getConfigHook(plugin: Plugin): ConfigHook {
  if (typeof plugin.config !== "function") {
    throw new Error("expected plugin config hook");
  }
  return plugin.config as ConfigHook;
}

function callConfigResolved(plugin: Plugin): void {
  (plugin.configResolved as () => void)();
}

function callCloseServer(plugin: Plugin, reason: "close" | "restart"): void {
  (plugin.closeServer as (context: { reason: string }) => void)({ reason });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("eveTanStack", () => {
  it("proxies eve routes through Nitro to a shared eve dev server", async () => {
    const result = await getConfigHook(eveTanStack())({}, serveEnv);

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "TanStack Start", slug: "tanstack" },
    });
    expect(result).toEqual({
      nitro: {
        routeRules: {
          [`${EVE_ROUTE_PREFIX}/**`]: { proxy: `http://127.0.0.1:49152${EVE_ROUTE_PREFIX}/**` },
        },
      },
    });
  });

  it("prefers EVE_BASE_URL over spawning a shared server", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com/root");

    const result = await getConfigHook(eveTanStack())({}, serveEnv);

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      nitro: {
        routeRules: {
          [`${EVE_ROUTE_PREFIX}/**`]: {
            proxy: `https://agent.example.com${EVE_ROUTE_PREFIX}/**`,
          },
        },
      },
    });
  });

  it("names EVE_BASE_URL when it is not an absolute URL", async () => {
    vi.stubEnv("EVE_BASE_URL", "localhost:2000");

    await expect(getConfigHook(eveTanStack())({}, serveEnv)).rejects.toThrow(
      /EVE_BASE_URL must be an absolute http\(s\) URL/,
    );
    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
  });

  it("resolves eveRoot against the Vite root", async () => {
    await getConfigHook(eveTanStack({ eveRoot: "agent" }))({ root: "/projects/web" }, serveEnv);

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot: "/projects/web/agent" }),
    );
  });

  it("passes devServerTimeoutMs to the shared eve dev server", async () => {
    await getConfigHook(eveTanStack({ devServerTimeoutMs: 5000 }))({}, serveEnv);

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it("rejects a non-positive devServerTimeoutMs", () => {
    expect(() => eveTanStack({ devServerTimeoutMs: 0 })).toThrow(
      /TanStack Start development server timeout must be a positive number/,
    );
  });

  it("stops a dev server it spawned when Vite closes, but not when Vite restarts", async () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    resolveSharedEveDevServerMock.mockResolvedValueOnce({
      origin: "http://127.0.0.1:49152",
      process: child,
    });
    const plugin = eveTanStack();
    await getConfigHook(plugin)({ root: "/projects/spawned" }, serveEnv);

    callCloseServer(plugin, "restart");
    expect(kill).not.toHaveBeenCalled();

    // Vite re-runs vite.config.ts on restart; the new plugin instance reuses
    // the registered server and owns its shutdown.
    const restarted = eveTanStack();
    await getConfigHook(restarted)({ root: "/projects/spawned" }, serveEnv);
    callCloseServer(restarted, "close");
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not start eve for local production preview", async () => {
    const plugin = eveTanStack();
    const result = await getConfigHook(plugin)(
      {},
      { command: "serve", isPreview: true, mode: "production" },
    );

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result).toEqual({});
    expect(() => callConfigResolved(plugin)).not.toThrow();
  });

  it("adds no Nitro config for builds", async () => {
    vi.stubEnv("VERCEL", "1");

    const result = await getConfigHook(eveTanStack())({}, buildEnv);

    expect(result).toEqual({});
  });

  it("leaves Nitro's Vercel config alone outside Vercel builds", async () => {
    const plugin = eveTanStack() as EveTanStackPlugin;
    await getConfigHook(plugin)({}, buildEnv);
    const options: NitroOptions = {};

    await plugin.nitro.setup({ options });

    expect(ensureEveVercelServicesConfigMock).not.toHaveBeenCalled();
    expect(options).toEqual({});
  });

  it("merges the generated eve service into the user's resolved Nitro Vercel config", async () => {
    vi.stubEnv("VERCEL", "1");
    const generated = { mode: "generated", services: {} } as const;
    ensureEveVercelServicesConfigMock.mockResolvedValueOnce(generated);
    const plugin = eveTanStack({
      eveBuildCommand: "pnpm build:eve",
      eveRoot: "agent",
    }) as EveTanStackPlugin;
    await getConfigHook(plugin)({ root: "/projects/web" }, buildEnv);
    const userConfig: VercelBuildConfig = { routes: [{ src: "/(.*)", dest: "/" }] };
    const options: NitroOptions = { vercel: { config: userConfig, functions: {} } };

    await plugin.nitro.setup({ options });

    expect(ensureEveVercelServicesConfigMock).toHaveBeenCalledWith({
      appRoot: "/projects/web/agent",
      eveBuildCommand: "pnpm build:eve",
      frameworkName: "TanStack Start",
      hostRoot: "/projects/web",
    });
    expect(mergeEveVercelConfigMock).toHaveBeenCalledWith(userConfig, generated);
    expect(options.vercel).toEqual({
      config: { routes: [], services: {}, version: 3 },
      functions: {},
    });
  });

  it("leaves routing to the user's services config when vercel.json declares services", async () => {
    vi.stubEnv("VERCEL", "1");
    const plugin = eveTanStack() as EveTanStackPlugin;
    await getConfigHook(plugin)({}, buildEnv);
    const options: NitroOptions = {};

    await plugin.nitro.setup({ options });

    expect(mergeEveVercelConfigMock).not.toHaveBeenCalled();
    expect(options).toEqual({});
  });

  it("fails fast when the Nitro Vite plugin did not install its module", async () => {
    const plugin = eveTanStack() as EveTanStackPlugin;
    await getConfigHook(plugin)({}, buildEnv);

    expect(() => callConfigResolved(plugin)).toThrow(/nitro\(\) from "nitro\/vite"/);

    await plugin.nitro.setup({ options: {} });
    expect(() => callConfigResolved(plugin)).not.toThrow();
  });
});
