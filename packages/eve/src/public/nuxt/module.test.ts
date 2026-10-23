import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const nuxtKit = vi.hoisted(() => ({
  definition: undefined as
    | {
        readonly defaults?: Record<string, unknown>;
        readonly setup: (options: Record<string, unknown>, nuxt: FakeNuxt) => Promise<void>;
      }
    | undefined,
}));

vi.mock("@nuxt/kit", () => ({
  addImports: vi.fn(),
  // The real `defineNuxtModule` wraps setup in Nuxt's module contract; the
  // tests drive setup directly instead.
  defineNuxtModule: (definition: NonNullable<typeof nuxtKit.definition>) => {
    nuxtKit.definition = definition;
    return definition;
  },
  extendRouteRules: vi.fn(),
}));

vi.mock("#shared/framework-eve-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#shared/framework-eve-server.js")>()),
  resolveSharedEveDevServer: vi.fn(async () => ({ origin: "http://127.0.0.1:49152" })),
}));

vi.mock("#shared/vercel-services.js", () => ({
  ensureEveVercelServicesConfig: vi.fn(async () => ({ mode: "root" })),
  mergeEveVercelConfig: vi.fn(() => ({ merged: true })),
}));

const { addImports, extendRouteRules } = await import("@nuxt/kit");
const { resolveSharedEveDevServer } = await import("#shared/framework-eve-server.js");
const { ensureEveVercelServicesConfig, mergeEveVercelConfig } =
  await import("#shared/vercel-services.js");

// Importing the module runs `defineNuxtModule`, which the mock captures.
await import("./module.js");

interface FakeNuxt {
  readonly options: {
    readonly dev: boolean;
    readonly rootDir: string;
    readonly nitro: { vercel?: { config?: unknown } };
  };
  readonly hook: (name: string, handler: () => unknown) => void;
  readonly runHook: (name: string) => Promise<void>;
}

function createNuxt(input: { readonly dev: boolean; readonly rootDir?: string }): FakeNuxt {
  const handlers = new Map<string, (() => unknown)[]>();
  return {
    options: {
      dev: input.dev,
      nitro: {},
      rootDir: input.rootDir ?? "/app",
    },
    hook(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    async runHook(name) {
      for (const handler of handlers.get(name) ?? []) {
        await handler();
      }
    },
  };
}

async function setupModule(input: {
  readonly dev: boolean;
  readonly options?: Record<string, unknown>;
  readonly rootDir?: string;
}): Promise<FakeNuxt> {
  const definition = nuxtKit.definition;
  if (definition === undefined) throw new Error("the eve Nuxt module did not register");

  const nuxt = createNuxt({ dev: input.dev, rootDir: input.rootDir });
  await definition.setup({ ...definition.defaults, ...input.options }, nuxt);
  await nuxt.runHook("modules:done");
  return nuxt;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("eve/nuxt module", () => {
  it("auto-imports useEveAgent and proxies eve routes to a shared dev server", async () => {
    await setupModule({ dev: true });

    expect(addImports).toHaveBeenCalledWith({ name: "useEveAgent", from: "eve/vue" });
    expect(resolveSharedEveDevServer).toHaveBeenCalledWith({
      appRoot: "/app",
      host: { label: "Nuxt", slug: "nuxt" },
      timeoutMs: undefined,
    });
    expect(extendRouteRules).toHaveBeenCalledWith(`${EVE_ROUTE_PREFIX}/**`, {
      proxy: `http://127.0.0.1:49152${EVE_ROUTE_PREFIX}/**`,
    });
  });

  it("spawns the dev server from eveRoot and forwards devServerTimeoutMs", async () => {
    await setupModule({
      dev: true,
      options: { devServerTimeoutMs: 5_000, eveRoot: "agent" },
    });

    expect(resolveSharedEveDevServer).toHaveBeenCalledWith({
      appRoot: "/app/agent",
      host: { label: "Nuxt", slug: "nuxt" },
      timeoutMs: 5_000,
    });
  });

  it("rejects a non-positive devServerTimeoutMs", async () => {
    await expect(setupModule({ dev: true, options: { devServerTimeoutMs: -1 } })).rejects.toThrow(
      /Nuxt development server timeout/,
    );
  });

  it("prefers EVE_BASE_URL over spawning a dev server", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://agent.example.com/root");

    await setupModule({ dev: true });

    expect(resolveSharedEveDevServer).not.toHaveBeenCalled();
    expect(extendRouteRules).toHaveBeenCalledWith(`${EVE_ROUTE_PREFIX}/**`, {
      proxy: `https://agent.example.com${EVE_ROUTE_PREFIX}/**`,
    });
  });

  it("proxies to the configured production origin outside Vercel", async () => {
    vi.stubEnv("EVE_NUXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    await setupModule({ dev: false });

    expect(resolveSharedEveDevServer).not.toHaveBeenCalled();
    expect(extendRouteRules).toHaveBeenCalledWith(`${EVE_ROUTE_PREFIX}/**`, {
      proxy: `https://agent.example.com${EVE_ROUTE_PREFIX}/**`,
    });
  });

  it("proxies to the default loopback port outside Vercel", async () => {
    await setupModule({ dev: false });

    expect(extendRouteRules).toHaveBeenCalledWith(`${EVE_ROUTE_PREFIX}/**`, {
      proxy: `http://127.0.0.1:4274${EVE_ROUTE_PREFIX}/**`,
    });
  });

  it("merges the generated eve service into the Nitro Vercel config on Vercel builds", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.mocked(ensureEveVercelServicesConfig).mockResolvedValueOnce({
      mode: "generated",
    } as Awaited<ReturnType<typeof ensureEveVercelServicesConfig>>);

    const nuxt = await setupModule({
      dev: false,
      options: { eveBuildCommand: "pnpm build:eve", eveRoot: "agent" },
    });

    expect(ensureEveVercelServicesConfig).toHaveBeenCalledWith({
      appRoot: "/app/agent",
      eveBuildCommand: "pnpm build:eve",
      frameworkName: "Nuxt",
      hostRoot: "/app",
    });
    expect(mergeEveVercelConfig).toHaveBeenCalledWith(undefined, { mode: "generated" });
    expect(nuxt.options.nitro.vercel?.config).toEqual({ merged: true });
    expect(extendRouteRules).not.toHaveBeenCalled();
  });

  it("leaves the Nitro Vercel config alone when vercel.json owns routing", async () => {
    vi.stubEnv("VERCEL", "1");

    const nuxt = await setupModule({ dev: false });

    expect(mergeEveVercelConfig).not.toHaveBeenCalled();
    expect(nuxt.options.nitro.vercel).toBeUndefined();
  });
});
