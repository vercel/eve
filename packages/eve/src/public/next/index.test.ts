import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./vercel-output-config.js", () => ({
  ensureEveVercelOutputConfig: vi.fn(async (input: { readonly servicePrefix: string }) => ({
    servicePrefix: input.servicePrefix,
  })),
}));

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
    vi.unstubAllEnvs();
  });

  it("emits Eve rewrites through beforeFiles when no user rewrites exist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(isRewriteSections(rewrites)).toBe(true);
    if (!isRewriteSections(rewrites)) {
      return;
    }

    expect(rewrites.beforeFiles).toEqual([
      {
        destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
        source: "/eve/v1/:path+",
      },
    ]);
  });

  it("omits the basePath override so Next.js applies a configured basePath", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>({
        basePath: "/web",
      }),
    );
    const rewrites = await config.rewrites?.();
    const [eveRewrite] = getBeforeFiles(rewrites);

    expect(eveRewrite).toEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
    expect(eveRewrite).not.toHaveProperty("basePath");
  });

  it("adds production Vercel rewrites to the private Eve service namespace", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("only rewrites Eve-prefixed non-index routes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();
    const beforeFiles = getBeforeFiles(rewrites);

    expect(beforeFiles.map((rewrite) => rewrite.source)).not.toContain("/");
    expect(beforeFiles.map((rewrite) => rewrite.source)).not.toContain("/eve/v1");
    expect(beforeFiles.every((rewrite) => rewrite.source.startsWith("/eve/v1/"))).toBe(true);
  });

  it("rewrites authored channel routes under the Eve protocol prefix", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
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

  it("ignores Vercel deployment URL when creating local service rewrites", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "http://preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("ignores production origin overrides on Vercel", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com/root");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("preserves object config values and existing array rewrites", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

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
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
    expect(rewrites.afterFiles).toContainEqual({
      destination: "/legacy",
      source: "/legacy",
    });
  });

  it("prepends Eve rewrites to beforeFiles when user rewrites use sections", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

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
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
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
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

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
      destination: "/internal/eve/eve/v1/:path+",
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
