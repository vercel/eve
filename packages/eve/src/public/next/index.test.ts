import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./resolve-eve-binary.js", async () => {
  const { join } = await import("node:path");
  return {
    // Pin resolution to the conventional app-local path so the default
    // build-command assertion is deterministic without touching the
    // filesystem. The real resolver is covered by its own integration test.
    resolveEveBinaryPath: (nextRoot: string) =>
      join(nextRoot, "node_modules", "eve", "bin", "eve.js"),
  };
});

vi.mock("./vercel-output-config.js", () => ({
  ensureEveVercelOutputConfig: vi.fn(
    async (input: {
      readonly agents: readonly {
        readonly name?: string;
        readonly servicePrefix: string;
      }[];
    }) => ({
      agents: input.agents.map((agent) => ({
        name: agent.name,
        servicePrefix: agent.servicePrefix,
      })),
    }),
  ),
}));

const { ensureEveVercelOutputConfig } = await import("./vercel-output-config.js");

vi.mock("./server.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./server.js")>();
  return {
    ...original,
    resolveEveDestinationPrefix: vi.fn(original.resolveEveDestinationPrefix),
  };
});

const { resolveEveDestinationPrefix } = await import("./server.js");

import {
  EVE_NEXT_SERVICE_PREFIX,
  withEve,
  type EveNextConfig,
  type EveNextRewriteSections,
} from "./index.js";

interface TestConfig extends EveNextConfig {
  readonly basePath?: string;
}

async function resolveConfig(config: ReturnType<typeof withEve<TestConfig>>): Promise<TestConfig> {
  return await config("phase-test", {
    defaultConfig: {},
  });
}

describe("withEve", () => {
  afterEach(() => {
    vi.mocked(resolveEveDestinationPrefix).mockClear();
    vi.mocked(ensureEveVercelOutputConfig).mockClear();
    vi.unstubAllEnvs();
  });

  it("does not add Next.js rewrites on Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(rewrites).toBeUndefined();
  });

  it("omits the basePath override so Next.js applies a configured basePath", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>({
        basePath: "/web",
      }),
    );
    const rewrites = await config.rewrites?.();
    const [eveRewrite] = getBeforeFiles(rewrites);

    expect(eveRewrite).toEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
    expect(eveRewrite).not.toHaveProperty("basePath");
  });

  it("adds non-Vercel production rewrites to the configured eve service namespace", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("only rewrites eve-prefixed non-index routes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();
    const beforeFiles = getBeforeFiles(rewrites);

    expect(beforeFiles.map((rewrite) => rewrite.source)).not.toContain("/");
    expect(beforeFiles.map((rewrite) => rewrite.source)).not.toContain("/eve/v1");
    expect(beforeFiles.every((rewrite) => rewrite.source.startsWith("/eve/v1/"))).toBe(true);
  });

  it("rewrites authored channel routes under the eve protocol prefix", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("uses EVE_BASE_URL in development instead of starting a server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EVE_BASE_URL", " http://127.0.0.1:49152/ ");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:49152/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("ignores Vercel deployment URL by leaving routing to Build Output config", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "http://preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(rewrites).toBeUndefined();
  });

  it("ignores production origin overrides on Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com/root");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(rewrites).toBeUndefined();
  });

  it("preserves object config values and existing array rewrites", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>({
        basePath: "/web",
        async rewrites() {
          return [
            {
              destination: "/legacy",
              source: "/legacy",
            },
          ];
        },
      }),
    );
    const rewrites = await config.rewrites?.();

    expect(config.basePath).toBe("/web");
    expect(isRewriteSections(rewrites)).toBe(true);
    if (!isRewriteSections(rewrites)) {
      return;
    }

    expect(rewrites.beforeFiles).toContainEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
    expect(rewrites.afterFiles).toContainEqual({
      destination: "/legacy",
      source: "/legacy",
    });
  });

  it("prepends eve rewrites to beforeFiles when user rewrites use sections", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>({
        async rewrites() {
          return {
            afterFiles: [
              {
                destination: "/after",
                source: "/after",
              },
            ],
            beforeFiles: [
              {
                destination: "/before",
                source: "/before",
              },
            ],
          };
        },
      }),
    );
    const rewrites = await config.rewrites?.();

    expect(isRewriteSections(rewrites)).toBe(true);
    if (!isRewriteSections(rewrites)) {
      return;
    }

    expect(rewrites.beforeFiles?.at(0)).toEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
    expect(rewrites.beforeFiles).toContainEqual({
      destination: "/before",
      source: "/before",
    });
    expect(rewrites.afterFiles).toEqual([
      {
        destination: "/after",
        source: "/after",
      },
    ]);
  });

  it("accepts a custom private service prefix", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>(
        {},
        {
          servicePrefix: "internal/eve",
        },
      ),
    );
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "https://agent.example.com/internal/eve/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("accepts a production origin override outside Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com/root");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("uses a stable local production port while Next.js is building outside Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const config = await withEve<TestConfig>({})("phase-production-build", {
      defaultConfig: {},
    });
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:4274/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("accepts a custom stable local production port", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_PORT", "51234");

    const config = await withEve<TestConfig>({})("phase-production-build", {
      defaultConfig: {},
    });
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:51234/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("adds named agent rewrites with derived and per-agent service prefixes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>(
        {},
        {
          agents: {
            billing: {
              buildCommand: "pnpm build:billing-agent",
              root: "./agents/billing",
              servicePrefix: "/_eve_internal/billing",
            },
            support: "./agents/support",
          },
        },
      ),
    );
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toEqual(
      expect.arrayContaining([
        {
          destination: `https://agent.example.com${EVE_NEXT_SERVICE_PREFIX}/support/eve/v1/:path+`,
          source: "/eve/agents/support/eve/v1/:path+",
        },
        {
          destination: "https://agent.example.com/_eve_internal/billing/eve/v1/:path+",
          source: "/eve/agents/billing/eve/v1/:path+",
        },
      ]),
    );
    expect(ensureEveVercelOutputConfig).toHaveBeenCalledWith({
      agents: [
        {
          appRoot: expect.stringContaining("/agents/billing"),
          buildCommand: "pnpm build:billing-agent",
          name: "billing",
          publicRoutePrefix: "/eve/agents/billing",
          servicePrefix: "/_eve_internal/billing",
        },
        {
          appRoot: expect.stringContaining("/agents/support"),
          buildCommand: "node '../../node_modules/eve/bin/eve.js' build",
          name: "support",
          publicRoutePrefix: "/eve/agents/support",
          servicePrefix: `${EVE_NEXT_SERVICE_PREFIX}/support`,
        },
      ],
      nextRoot: process.cwd(),
    });
  });

  it("uses adjacent stable local production ports for named agents", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const config = await withEve<TestConfig>(
      {},
      {
        agents: {
          billing: "./agents/billing",
          support: "./agents/support",
        },
      },
    )("phase-production-build", {
      defaultConfig: {},
    });
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toEqual(
      expect.arrayContaining([
        {
          destination: "http://127.0.0.1:4274/eve/v1/:path+",
          source: "/eve/agents/billing/eve/v1/:path+",
        },
        {
          destination: "http://127.0.0.1:4275/eve/v1/:path+",
          source: "/eve/agents/support/eve/v1/:path+",
        },
      ]),
    );
  });

  it("rejects eveRoot when named agents are configured", () => {
    expect(() =>
      withEve<TestConfig>(
        {},
        {
          agents: {
            support: "./agents/support",
          },
          eveRoot: "./agent",
        },
      ),
    ).toThrow("withEve cannot combine eveRoot with agents");
  });

  it("rejects invalid named agent route segments", () => {
    expect(() =>
      withEve<TestConfig>(
        {},
        {
          agents: {
            Support: "./agents/support",
          },
        },
      ),
    ).toThrow("eve Next.js agent name");
  });
});

function getBeforeFiles(
  rewrites: Awaited<ReturnType<NonNullable<TestConfig["rewrites"]>>> | undefined,
): readonly NonNullable<EveNextRewriteSections["beforeFiles"]>[number][] {
  expect(isRewriteSections(rewrites)).toBe(true);
  if (!isRewriteSections(rewrites)) {
    return [];
  }

  return rewrites.beforeFiles ?? [];
}

function isRewriteSections(
  rewrites: Awaited<ReturnType<NonNullable<TestConfig["rewrites"]>>> | undefined,
): rewrites is EveNextRewriteSections {
  return rewrites !== undefined && !Array.isArray(rewrites);
}
