import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

import { eveSvelteKit } from "./index.js";
import { resolveSharedEveDevServer } from "./dev-server.js";
import { ensureEveVercelJson } from "./vercel-json.js";

vi.mock("./dev-server.js", () => ({
  EVE_BASE_URL_ENV: "EVE_BASE_URL",
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("./vercel-json.js", () => ({
  ensureEveVercelJson: vi.fn(async () => ({ servicePrefix: "/_eve_internal/eve" })),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const ensureEveVercelJsonMock = vi.mocked(ensureEveVercelJson);

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

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(process.cwd());
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

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(process.cwd());
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

  it("configures vercel.json during production builds", async () => {
    const plugin = eveSvelteKit({ eveBuildCommand: "pnpm build:eve", eveRoot: "agent" });

    await getConfigHook(plugin)({}, { command: "build", mode: "production" });

    expect(ensureEveVercelJsonMock).toHaveBeenCalledWith({
      appRoot: expect.stringMatching(/agent$/),
      eveBuildCommand: "pnpm build:eve",
      servicePrefix: "/_eve_internal/eve",
      svelteKitRoot: process.cwd(),
    });
  });
});
