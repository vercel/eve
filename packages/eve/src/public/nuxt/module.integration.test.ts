import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extendRouteRules } from "@nuxt/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSharedEveDevServer } from "#shared/framework-eve-server.js";
import type { VercelBuildConfig } from "#shared/vercel-services.js";

import type { EveNuxtModuleOptions } from "./module.js";
import "./module.js";

const { moduleSetup } = vi.hoisted(() => ({
  moduleSetup: vi.fn<(options: EveNuxtModuleOptions, nuxt: NuxtHost) => Promise<void>>(),
}));

vi.mock("@nuxt/kit", () => ({
  addImports: vi.fn(),
  defineNuxtModule: (definition: {
    setup: (options: EveNuxtModuleOptions, nuxt: NuxtHost) => Promise<void>;
  }) => {
    moduleSetup.mockImplementation(definition.setup);
    return () => {};
  },
  extendRouteRules: vi.fn(),
}));
vi.mock("#shared/framework-eve-server.js", () => ({
  resolveDevServerTimeout: () => undefined,
  resolveSharedEveDevServer: vi.fn(async ({ appRoot }: { appRoot: string }) => ({
    origin: appRoot.endsWith("billing") ? "http://127.0.0.1:49152" : "http://127.0.0.1:49153",
  })),
}));
vi.mock("#shared/resolve-eve-binary.js", () => ({
  resolveEveBinaryPath: (root: string) => join(root, "node_modules/eve/bin/eve.js"),
}));

interface NuxtHost {
  options: {
    rootDir: string;
    dev: boolean;
    vite: { optimizeDeps?: { include?: string[] } };
    nitro: { vercel?: { config?: VercelBuildConfig } };
  };
  hook: (name: string, callback: () => Promise<void> | void) => void;
}
const roots: string[] = [];

async function createWorkspaceHost(dev: boolean) {
  const root = await mkdtemp(join(tmpdir(), "eve-nuxt-workspace-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { eve: "0.0.0" } }));
  for (const name of ["billing", "support"]) {
    await mkdir(join(root, "agents", name, "agent"), { recursive: true });
    await writeFile(join(root, "agents", name, "agent/agent.ts"), "export default {};\n");
  }
  const hooks = new Map<string, (() => Promise<void> | void)[]>();
  const nuxt: NuxtHost = {
    options: { rootDir: root, dev, vite: {}, nitro: {} },
    hook(name, callback) {
      hooks.set(name, [...(hooks.get(name) ?? []), callback]);
    },
  };
  return { root, nuxt, hooks };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Nuxt workspace mounting", () => {
  it.each([undefined, "https://agents.example.com"])(
    "mounts named routes with EVE_BASE_URL=%s",
    async (baseUrl) => {
      const { root, nuxt, hooks } = await createWorkspaceHost(true);
      if (baseUrl !== undefined) vi.stubEnv("EVE_BASE_URL", baseUrl);
      await moduleSetup({ eveRoot: `${root}/` }, nuxt);
      for (const callback of hooks.get("modules:done") ?? []) await callback();
      expect(vi.mocked(extendRouteRules).mock.calls).toEqual([
        [
          "/eve/billing/v1/**",
          {
            proxy:
              baseUrl === undefined
                ? "http://127.0.0.1:49152/eve/v1/**"
                : `${baseUrl}/eve/billing/v1/**`,
          },
        ],
        [
          "/eve/support/v1/**",
          {
            proxy:
              baseUrl === undefined
                ? "http://127.0.0.1:49153/eve/v1/**"
                : `${baseUrl}/eve/support/v1/**`,
          },
        ],
      ]);
      if (baseUrl !== undefined) expect(resolveSharedEveDevServer).not.toHaveBeenCalled();
    },
  );

  it("composes discovered Vercel services with authored Nitro routes and services", async () => {
    vi.stubEnv("VERCEL", "1");
    const { root, nuxt } = await createWorkspaceHost(false);
    nuxt.options.nitro.vercel = {
      config: {
        routes: [{ src: "^/custom$", dest: "/page" }, { handle: "filesystem" }],
        services: {
          "eve-support": { framework: "eve", root: "custom-agent", buildCommand: "pnpm custom" },
        },
      },
    };
    await moduleSetup({ eveRoot: root }, nuxt);
    const config = nuxt.options.nitro.vercel.config!;
    expect(Object.keys(config.services!)).toEqual(["eve-support", "eve-billing"]);
    expect(config.services?.["eve-support"]).toMatchObject({
      root: "custom-agent",
      buildCommand: "pnpm custom",
    });
    expect(config.routes?.[0]).toMatchObject({ src: "^/custom$", dest: "/page" });
    expect(config.routes?.at(-1)).toMatchObject({ handle: "filesystem" });
    expect(extendRouteRules).not.toHaveBeenCalled();
  });
});
