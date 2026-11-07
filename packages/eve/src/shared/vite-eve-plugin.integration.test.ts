import { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigEnv, Plugin, UserConfig } from "vite";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { VercelServicesConfig } from "#internal/vercel/vercel-services-config.js";
import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";

import { createEveVitePlugin } from "./vite-eve-plugin.js";

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

const resolveSharedEveDevServerMock = vi.mocked(resolveSharedEveDevServer);
const createTemporaryDirectory = useTemporaryDirectories();

const host = { label: "Test", slug: "test" };
const serveEnv: ConfigEnv = { command: "serve", mode: "development" };
const previewEnv: ConfigEnv = { command: "serve", isPreview: true, mode: "production" };
const buildEnv: ConfigEnv = { command: "build", mode: "production" };

type EveVitePlugin = Plugin & {
  nitro: {
    setup(nitro: { options: { vercel?: { config?: VercelServicesConfig } } }): Promise<void>;
  };
};

async function createAgentProject(): Promise<string> {
  const root = await createTemporaryDirectory("eve-vite-plugin-");
  await mkdir(join(root, "agent"), { recursive: true });
  return root;
}

async function runConfig(
  plugin: Plugin,
  root: string,
  env: ConfigEnv,
  plugins: UserConfig["plugins"] = [],
): Promise<UserConfig> {
  const config = plugin.config as {
    handler: (config: UserConfig, env: ConfigEnv) => Promise<UserConfig>;
  };
  return await config.handler({ plugins, root }, env);
}

async function runConfigResolved(plugin: Plugin): Promise<void> {
  (plugin.configResolved as (config: { build: { ssr: boolean } }) => void)({
    build: { ssr: false },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("createEveVitePlugin", () => {
  it("prefers EVE_BASE_URL over starting a dev server", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com/root");
    const root = await createAgentProject();

    const result = await runConfig(createEveVitePlugin({ host, options: {} }), root, serveEnv);

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result.server?.proxy).toEqual({
      "/eve/v1": expect.objectContaining({ target: "https://agent.example.com" }),
    });
  });

  it("names EVE_BASE_URL when it is not an absolute URL", async () => {
    vi.stubEnv("EVE_BASE_URL", "localhost:2000");
    const root = await createAgentProject();

    await expect(
      runConfig(createEveVitePlugin({ host, options: {} }), root, serveEnv),
    ).rejects.toThrow(/EVE_BASE_URL must be an absolute http\(s\) URL/);
    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
  });

  it("proxies to EVE_BASE_URL without local agent files", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com");
    const root = await createTemporaryDirectory("eve-vite-plugin-");

    const result = await runConfig(createEveVitePlugin({ host, options: {} }), root, serveEnv);

    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
    expect(result.server?.proxy?.["/eve/v1"]).toBeDefined();
  });

  it("skips agent discovery for builds", async () => {
    const root = await createTemporaryDirectory("eve-vite-plugin-");

    await expect(
      runConfig(createEveVitePlugin({ host, options: {} }), root, buildEnv),
    ).resolves.toEqual({});
  });

  it("passes devServerTimeoutMs to the shared dev server", async () => {
    const root = await createAgentProject();

    await runConfig(
      createEveVitePlugin({ host, options: { devServerTimeoutMs: 5000 } }),
      root,
      serveEnv,
    );

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });

  it("rejects a non-positive devServerTimeoutMs", () => {
    expect(() => createEveVitePlugin({ host, options: { devServerTimeoutMs: 0 } })).toThrow(
      /Test development server timeout must be a positive number/,
    );
  });

  it("stops a dev server it spawned when Vite closes, but not when Vite restarts", async () => {
    const root = await createAgentProject();
    const child = new ChildProcess();
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    resolveSharedEveDevServerMock.mockResolvedValueOnce({
      origin: "http://127.0.0.1:49152",
      process: child,
    });
    const plugin = createEveVitePlugin({ host, options: {} });
    await runConfig(plugin, root, serveEnv);
    const closeServer = plugin.closeServer as (context: { reason: string }) => void;

    closeServer({ reason: "restart" });
    expect(kill).not.toHaveBeenCalled();

    closeServer({ reason: "close" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not start eve for local production preview", async () => {
    const root = await createAgentProject();
    const plugin = createEveVitePlugin({ host, nitroOnly: true, options: {} });

    await expect(runConfig(plugin, root, previewEnv)).resolves.toEqual({});
    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
  });

  it("proxies each workspace member to its own dev server in preview", async () => {
    const root = await createTemporaryDirectory("eve-vite-plugin-");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "*" } }));
    await Promise.all([
      mkdir(join(root, "agents", "a", "agent"), { recursive: true }),
      mkdir(join(root, "agents", "b", "agent"), { recursive: true }),
    ]);
    resolveSharedEveDevServerMock
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:1111" })
      .mockResolvedValueOnce({ origin: "http://127.0.0.1:2222" });

    const result = await runConfig(createEveVitePlugin({ host, options: {} }), root, previewEnv);

    expect(resolveSharedEveDevServerMock).toHaveBeenCalledTimes(2);
    expect(result.preview?.proxy).toEqual({
      "/eve/a/v1": expect.objectContaining({ target: "http://127.0.0.1:1111" }),
      "/eve/b/v1": expect.objectContaining({ target: "http://127.0.0.1:2222" }),
    });
  });

  it("fails fast when a Nitro-only host did not install the Nitro plugin", async () => {
    const root = await createAgentProject();
    const plugin = createEveVitePlugin({ host, nitroOnly: true, options: {} });
    await runConfig(plugin, root, buildEnv);

    await expect(runConfigResolved(plugin)).rejects.toThrow(/nitro\(\) from "nitro\/vite"/);
  });

  it("adds nothing to preview when Nitro serves it", async () => {
    const root = await createAgentProject();
    const plugin = createEveVitePlugin({ host, options: {} });

    const result = await runConfig(plugin, root, previewEnv, [{ name: "nitro:preview" }]);

    expect(result).toEqual({});
    expect(resolveSharedEveDevServerMock).not.toHaveBeenCalled();
  });

  it("merges the generated eve service into the user's Nitro Vercel config", async () => {
    vi.stubEnv("VERCEL", "1");
    const root = await createAgentProject();
    const plugin = createEveVitePlugin({ host, options: {} }) as EveVitePlugin;
    await runConfig(plugin, root, buildEnv);
    const userConfig: VercelServicesConfig = { routes: [{ src: "/(.*)", dest: "/" }] };
    const options = { vercel: { config: userConfig } };

    await plugin.nitro.setup({ options });

    expect(
      Object.values(options.vercel.config?.services ?? {}).map((service) => service.framework),
    ).toContain("eve");
    expect(options.vercel.config?.routes?.map((route) => route.src)).toEqual([
      "^/eve/v1/(.*)$",
      "/(.*)",
    ]);
  });

  it("leaves routing to the user's services config when vercel.json declares services", async () => {
    vi.stubEnv("VERCEL", "1");
    const root = await createAgentProject();
    await writeFile(
      join(root, "vercel.json"),
      JSON.stringify({ services: { web: { framework: "vite", root: "." } } }),
    );
    const plugin = createEveVitePlugin({ host, options: {} }) as EveVitePlugin;
    await runConfig(plugin, root, buildEnv);
    const options: { vercel?: { config?: VercelServicesConfig } } = {};

    await expect(plugin.nitro.setup({ options })).rejects.toThrow(/already defines services/);
    expect(options.vercel).toBeUndefined();
  });
});
