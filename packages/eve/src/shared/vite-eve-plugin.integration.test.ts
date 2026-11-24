import { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppType, ConfigEnv, Plugin, UserConfig } from "vite";

import { resolvePackageSourceFilePath } from "#internal/application/package.js";
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

async function writeClientBuild(
  root: string,
  files: Record<string, string>,
  outDir = "dist",
): Promise<void> {
  await rm(join(root, outDir), { force: true, recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, outDir, path)), { recursive: true });
    await writeFile(join(root, outDir, path), contents);
  }
}

async function buildForVercel(
  root: string,
  build: { appType?: AppType; base?: string; outDir?: string; ssr?: boolean } = {},
): Promise<void> {
  vi.stubEnv("VERCEL", "1");
  const plugin = createEveVitePlugin({ host, options: {} });
  await runConfig(plugin, root, buildEnv);
  const buildApp = plugin.buildApp as {
    handler: (builder: {
      config: { appType: AppType; base: string; build: { outDir: string; ssr: boolean } };
      environments: Record<string, { config: { build: { outDir: string } }; isBuilt: boolean }>;
    }) => Promise<void>;
  };
  const outDir = build.outDir ?? (build.ssr ? "server" : "dist");
  await buildApp.handler({
    config: {
      appType: build.appType ?? "spa",
      base: build.base ?? "/",
      build: { outDir, ssr: build.ssr ?? false },
    },
    environments: {
      [build.ssr ? "ssr" : "client"]: { config: { build: { outDir } }, isBuilt: true },
    },
  });
}

async function readOutputRoutes(root: string): Promise<unknown[]> {
  const source = await readFile(join(root, ".vercel", "output", "config.json"), "utf8");
  return (JSON.parse(source) as { routes: unknown[] }).routes;
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

  it("leaves the build to Vite when the agent's platform writes no platform output", async () => {
    const root = await createAgentProject();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "alice-app", type: "module" }),
    );
    await writeFile(
      join(root, "agent", "platform.ts"),
      [
        `import { definePlatform } from ${JSON.stringify(resolvePackageSourceFilePath("src/platform/declaration.ts"))};`,
        "export default definePlatform({",
        "  deployment: () => ({",
        '    environment: () => "production",',
        '    deploymentId: () => "dpl_alice",',
        "    productionHost: () => undefined,",
        "    publicHost: () => undefined,",
        "    scope: () => undefined,",
        "  }),",
        "});",
        "",
      ].join("\n"),
    );
    await writeClientBuild(root, { "index.html": "<html></html>" });

    await buildForVercel(root);

    expect(existsSync(join(root, ".vercel", "output"))).toBe(false);
  });

  it("declares buildApp only for Vercel builds so other plugins can own local builds", () => {
    vi.stubEnv("VERCEL", "");
    expect(createEveVitePlugin({ host, options: {} })).not.toHaveProperty("buildApp");

    vi.stubEnv("VERCEL", "1");
    expect(createEveVitePlugin({ host, options: {} })).toHaveProperty("buildApp.order", "post");
  });

  it("asks for a root index.html or a server adapter when the client build has none", async () => {
    const root = await createAgentProject();
    await writeClientBuild(root, { "assets/entry.js": "" });

    await expect(buildForVercel(root)).rejects.toThrow(
      /no root index\.html in .*dist.*A static app must build index\.html.*nitro\(\) from "nitro\/vite"/,
    );
    expect(existsSync(join(root, ".vercel", "output"))).toBe(false);
  });

  it.each<{ appType: AppType; fallback: boolean }>([
    { appType: "custom", fallback: true },
    { appType: "mpa", fallback: false },
  ])("writes static output for appType $appType with a root index.html", async (row) => {
    const root = await createAgentProject();
    await writeClientBuild(root, { "index.html": "<!doctype html>\n" });

    await buildForVercel(root, { appType: row.appType });

    expect(existsSync(join(root, ".vercel", "output", "static", "index.html"))).toBe(true);
    expect((await readOutputRoutes(root)).at(-1)).toEqual(
      row.fallback ? { dest: "/index.html", src: "^\\/(.*)$" } : { handle: "filesystem" },
    );
  });

  it("mounts the static output and SPA fallback under an absolute base", async () => {
    const root = await createAgentProject();
    await writeClientBuild(root, { "assets/app.js": "", "index.html": "<!doctype html>\n" });

    await buildForVercel(root, { base: "/app/" });

    const staticRoot = join(root, ".vercel", "output", "static");
    expect(existsSync(join(staticRoot, "app", "index.html"))).toBe(true);
    expect(existsSync(join(staticRoot, "app", "assets", "app.js"))).toBe(true);
    expect((await readOutputRoutes(root)).slice(-2)).toEqual([
      { handle: "filesystem" },
      { dest: "/app/index.html", src: "^\\/app\\/(.*)$" },
    ]);
  });

  it("keeps a client build that already lives in the static output", async () => {
    const root = await createAgentProject();
    const outDir = join(".vercel", "output", "static");
    await writeClientBuild(
      root,
      { "assets/app.js": "", "index.html": "<!doctype html>\n" },
      outDir,
    );

    await buildForVercel(root, { outDir });

    expect(await readdir(join(root, outDir, "assets"))).toEqual(["app.js"]);
    expect((await readOutputRoutes(root)).slice(-1)).toEqual([
      { dest: "/index.html", src: "^\\/(.*)$" },
    ]);
  });

  it("refuses a client build nested in the static output", async () => {
    const root = await createAgentProject();
    const outDir = join(".vercel", "output", "static", "client");
    await writeClientBuild(root, { "index.html": "<!doctype html>\n" }, outDir);

    await expect(buildForVercel(root, { outDir })).rejects.toThrow(
      /client build\.outDir .*client overlaps .*Set build\.outDir outside \.vercel\/output/,
    );
    expect(existsSync(join(root, outDir, "index.html"))).toBe(true);
  });

  it("refuses an SSR build whose outDir still holds a client index.html", async () => {
    const root = await createAgentProject();
    await writeClientBuild(root, { "index.html": "<!doctype html>\n" });

    await expect(buildForVercel(root, { outDir: "dist", ssr: true })).rejects.toThrow(
      /found an SSR build \(vite build --ssr\).*nitro\(\) from "nitro\/vite"/,
    );
    expect(existsSync(join(root, ".vercel", "output"))).toBe(false);
  });

  it("regenerates the static output it wrote and leaves adapter output alone", async () => {
    const root = await createAgentProject();
    const staticRoot = join(root, ".vercel", "output", "static");
    await writeClientBuild(root, { "assets/old.js": "", "index.html": "<!doctype html>\n" });
    await buildForVercel(root);

    await expect(buildForVercel(root, { ssr: true })).rejects.toThrow(/found an SSR build/);

    await writeClientBuild(root, { "assets/new.js": "", "index.html": "<!doctype html>\n" });
    await buildForVercel(root);
    expect(await readdir(join(staticRoot, "assets"))).toEqual(["new.js"]);

    await writeFile(
      join(root, ".vercel", "output", "config.json"),
      JSON.stringify({ routes: [{ handle: "filesystem" }], version: 3 }),
    );
    await writeClientBuild(root, { "assets/newer.js": "", "index.html": "<!doctype html>\n" });
    await buildForVercel(root);
    expect(await readdir(join(staticRoot, "assets"))).toEqual(["new.js"]);
    expect(await readOutputRoutes(root)).not.toContainEqual(
      expect.objectContaining({ dest: "/index.html" }),
    );
  });

  it("writes the static output when vercel.json or vercel.ts configures routing", async () => {
    const root = await createAgentProject();
    await writeClientBuild(root, { "index.html": "<!doctype html>\n" });
    await writeFile(
      join(root, "vercel.json"),
      JSON.stringify({
        cleanUrls: true,
        headers: [{ headers: [{ key: "X-Test", value: "1" }], source: "/(.*)" }],
        rewrites: [{ destination: "/index.html", source: "/(.*)" }],
      }),
    );
    await writeFile(join(root, "vercel.ts"), "export default { trailingSlash: true };\n");

    await buildForVercel(root);

    const config = JSON.parse(
      await readFile(join(root, ".vercel", "output", "config.json"), "utf8"),
    ) as { routes: unknown[]; services: Record<string, { framework?: string }> };
    expect(existsSync(join(root, ".vercel", "output", "static", "index.html"))).toBe(true);
    expect(config.routes[0]).toEqual(expect.objectContaining({ src: "^/eve/v1/(.*)$" }));
    expect(config.services.eve?.framework).toBe("eve");
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
