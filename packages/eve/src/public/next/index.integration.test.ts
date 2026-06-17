import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVE_NEXT_SERVICE_PREFIX,
  withEve,
  type EveNextConfig,
  type EveNextRewriteSections,
} from "./index.js";

interface TestConfig extends EveNextConfig {
  readonly basePath?: string;
}

async function createTempAppRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "eve-next-config-"));
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function resolveConfig(config: ReturnType<typeof withEve<TestConfig>>): Promise<TestConfig> {
  return await config("phase-test", {
    defaultConfig: {},
  });
}

describe("withEve Vercel config", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not create Build Output config when no Vercel project is detected", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: `${EVE_NEXT_SERVICE_PREFIX}/eve/v1/:path+`,
      source: "/eve/v1/:path+",
    });
  });

  it("writes Build Output config to the closest existing .vercel directory", async () => {
    const projectRoot = await createTempAppRoot();
    const appRoot = join(projectRoot, "apps", "web");
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(join(projectRoot, ".vercel", "project.json"), "{}\n");
    await mkdir(appRoot, { recursive: true });
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    await resolveConfig(withEve<TestConfig>({}));

    const outputConfig = await readJsonFile(join(projectRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toEqual({
      version: 3,
      experimentalServices: {
        eve: {
          buildCommand: "eve build",
          entrypoint: ".",
          framework: "eve",
          mount: EVE_NEXT_SERVICE_PREFIX,
          type: "web",
        },
        web: {
          entrypoint: ".",
          framework: "nextjs",
          mount: "/",
          type: "web",
        },
      },
    });
    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("uses an already configured root eve service prefix", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify(
        {
          $schema: "https://openapi.vercel.sh/vercel.json",
          experimentalServices: {
            agent: {
              entrypoint: "agent",
              framework: "eve",
              routePrefix: "/private/agent",
            },
            frontend: {
              entrypoint: ".",
              framework: "nextjs",
              routePrefix: "/",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "/private/agent/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("uses an already configured Build Output eve service prefix", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          experimentalServices: {
            agent: {
              entrypoint: "agent",
              framework: "eve",
              mount: "/private/agent",
              type: "web",
            },
            frontend: {
              entrypoint: ".",
              framework: "nextjs",
              mount: "/",
              type: "web",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toEqual({
      version: 3,
      experimentalServices: {
        agent: {
          entrypoint: "agent",
          framework: "eve",
          mount: "/private/agent",
          type: "web",
        },
        frontend: {
          entrypoint: ".",
          framework: "nextjs",
          mount: "/",
          type: "web",
        },
      },
    });
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "/private/agent/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("accepts a custom eve service build command", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    await mkdir(join(appRoot, ".vercel"), { recursive: true });
    await writeFile(join(appRoot, ".vercel", "project.json"), "{}\n");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    await resolveConfig(
      withEve<TestConfig>(
        {},
        {
          eveBuildCommand: "pnpm build:eve",
        },
      ),
    );
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toMatchObject({
      experimentalServices: {
        eve: {
          buildCommand: "pnpm build:eve",
        },
      },
    });
  });

  it("does not start a local eve build while Next.js is building", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    await mkdir(join(appRoot, ".output", "server"), {
      recursive: true,
    });
    await writeFile(join(appRoot, ".output", "server", "index.mjs"), "process.exit(1);\n");

    const config = await withEve<TestConfig>({})("phase-production-build", {
      defaultConfig: {},
    });
    const rewrites = await config.rewrites?.();

    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:4274/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("reuses an app-local development server registry before spawning", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    const resolvedAppRoot = process.cwd();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await mkdir(join(resolvedAppRoot, ".eve"), {
      recursive: true,
    });
    await writeFile(
      join(resolvedAppRoot, ".eve", "next-dev-server.json"),
      `${JSON.stringify(
        {
          appRoot: resolvedAppRoot,
          origin: "http://127.0.0.1:49152",
          pid: null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:49152/eve/v1/health", {
      signal: expect.any(AbortSignal),
    });
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:49152/eve/v1/:path+",
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
