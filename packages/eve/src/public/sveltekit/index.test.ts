import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveFrameworkAgents } from "#shared/framework-agents.js";
import { ensureEveVercelServicesConfig } from "#shared/vercel-services.js";

import { eveSvelteKit } from "./index.js";
import { resolveSharedEveDevServer } from "./dev-server.js";

vi.mock("#shared/framework-agents.js", () => ({
  assertFrameworkAgentsPresent: vi.fn(),
  resolveFrameworkAgents: vi.fn(async (appRoot: string) => [
    {
      appRoot,
      publicRoutePrefix: "",
      transportRoutePrefix: "/eve/v1",
      workspaceMember: false,
    },
  ]),
}));

vi.mock("./dev-server.js", () => ({
  EVE_BASE_URL_ENV: "EVE_BASE_URL",
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("#shared/vercel-services.js", () => ({
  ensureEveVercelServicesConfig: vi.fn(async () => ({ mode: "root" })),
  mergeEveVercelConfig: vi.fn(),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const resolveFrameworkAgentsMock = vi.mocked(resolveFrameworkAgents);
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

  it("proxies each workspace member through its named route", async () => {
    resolveFrameworkAgentsMock.mockResolvedValueOnce([
      {
        appRoot: "/repo/agents/billing",
        name: "billing",
        publicRoutePrefix: "/eve/billing",
        transportRoutePrefix: "/eve/billing/v1",
        workspaceMember: true,
      },
      {
        appRoot: "/repo/agents/support",
        name: "support",
        publicRoutePrefix: "/eve/support",
        transportRoutePrefix: "/eve/support/v1",
        workspaceMember: true,
      },
    ]);
    resolveSharedEveDevServerMock
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:49152" })
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:49153" });

    const result = (await getConfigHook(eveSvelteKit())(
      {},
      { command: "serve", mode: "development" },
    )) as UserConfig;

    const billingProxy = result.server?.proxy?.["/eve/billing/v1"];
    const supportProxy = result.server?.proxy?.["/eve/support/v1"];
    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith("/repo/agents/billing");
    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith("/repo/agents/support");
    expect(billingProxy).toMatchObject({ target: "http://127.0.0.1:49152" });
    expect(supportProxy).toMatchObject({ target: "http://127.0.0.1:49153" });
    expect(typeof billingProxy === "object" && billingProxy.rewrite?.("/eve/billing/v1/chat")).toBe(
      "/eve/v1/chat",
    );
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

  it("configures a generated Vercel service during Vercel production builds", async () => {
    vi.stubEnv("VERCEL", "1");
    const plugin = eveSvelteKit({ eveBuildCommand: "pnpm build:eve", eveRoot: "agent" });

    await getConfigHook(plugin)({}, { command: "build", mode: "production" });

    const agentRoot = expect.stringMatching(/agent$/);
    expect(ensureEveVercelServicesConfigMock).toHaveBeenCalledWith({
      agents: [
        {
          appRoot: agentRoot,
          publicRoutePrefix: "",
          transportRoutePrefix: EVE_ROUTE_PREFIX,
          workspaceMember: false,
        },
      ],
      appRoot: agentRoot,
      eveBuildCommand: "pnpm build:eve",
      frameworkName: "SvelteKit",
      hostRoot: process.cwd(),
    });
  });
});
