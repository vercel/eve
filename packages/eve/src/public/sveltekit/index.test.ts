import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { ensureEveVercelServicesConfig } from "#shared/vercel-services.js";

import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";

import { eveSvelteKit } from "./index.js";

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("#shared/vercel-services.js", () => ({
  ensureEveVercelServicesConfig: vi.fn(async () => ({ mode: "root" })),
  mergeEveVercelConfig: vi.fn(),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const ensureEveVercelServicesConfigMock = vi.mocked(ensureEveVercelServicesConfig);

type ConfigHook = (config: UserConfig, env: ConfigEnv) => unknown;

function getConfigHook(plugin: Plugin): ConfigHook {
  if (typeof plugin.config !== "function") {
    throw new Error("expected plugin config hook");
  }
  return plugin.config as ConfigHook;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("eveSvelteKit", () => {
  it("configures Vite dev server proxy to a shared eve server", async () => {
    const plugin = eveSvelteKit();
    const result = (await getConfigHook(plugin)(
      {
        server: {
          proxy: {
            "/api": "http://127.0.0.1:3000",
          },
        },
      },
      { command: "serve", mode: "development" },
    )) as UserConfig;

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "SvelteKit", slug: "sveltekit" },
      timeoutMs: undefined,
    });
    expect(result).toEqual({
      server: {
        proxy: {
          "/api": "http://127.0.0.1:3000",
          [EVE_ROUTE_PREFIX]: {
            changeOrigin: true,
            target: "http://127.0.0.1:49152",
          },
        },
      },
    });
  });

  it("configures Vite preview proxy and starts eve for local production preview", async () => {
    const plugin = eveSvelteKit();
    const result = (await getConfigHook(plugin)(
      {
        preview: {
          proxy: {
            "/api": "http://127.0.0.1:3000",
          },
        },
      },
      { command: "serve", isPreview: true, mode: "production" },
    )) as UserConfig;

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "SvelteKit", slug: "sveltekit" },
      timeoutMs: undefined,
    });
    expect(result).toEqual({
      preview: {
        proxy: {
          "/api": "http://127.0.0.1:3000",
          [EVE_ROUTE_PREFIX]: {
            changeOrigin: true,
            target: "http://127.0.0.1:49152",
          },
        },
      },
    });
  });

  it("prefers EVE_BASE_URL over spawning a shared server", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com/root");
    const plugin = eveSvelteKit();
    const result = (await getConfigHook(plugin)(
      {},
      { command: "serve", mode: "development" },
    )) as UserConfig;

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result.server?.proxy).toEqual({
      [EVE_ROUTE_PREFIX]: {
        changeOrigin: true,
        target: "https://agent.example.com",
      },
    });
  });

  it("forwards a configured devServerTimeoutMs to the shared dev server", async () => {
    const plugin = eveSvelteKit({ devServerTimeoutMs: 5_000 });

    await getConfigHook(plugin)({}, { command: "serve", mode: "development" });

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith({
      appRoot: process.cwd(),
      host: { label: "SvelteKit", slug: "sveltekit" },
      timeoutMs: 5_000,
    });
  });

  it("rejects a non-positive devServerTimeoutMs", () => {
    expect(() => eveSvelteKit({ devServerTimeoutMs: 0 })).toThrow(
      /SvelteKit development server timeout/,
    );
  });

  it("configures a generated Vercel service during Vercel production builds", async () => {
    vi.stubEnv("VERCEL", "1");
    const plugin = eveSvelteKit({ eveBuildCommand: "pnpm build:eve", eveRoot: "agent" });

    await getConfigHook(plugin)({}, { command: "build", mode: "production" });

    expect(ensureEveVercelServicesConfigMock).toHaveBeenCalledWith({
      appRoot: expect.stringMatching(/agent$/),
      eveBuildCommand: "pnpm build:eve",
      frameworkName: "SvelteKit",
      hostRoot: process.cwd(),
    });
  });
});
