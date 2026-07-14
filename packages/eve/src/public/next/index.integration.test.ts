import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withEve, type EveNextConfig, type EveNextRewriteSections } from "./index.js";

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

  it("does not create Build Output config outside Vercel when no Vercel project is detected", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();

    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:4274/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });

  it("writes Build Output config in Vercel even when no linked project is detected", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toEqual({
      routes: [
        {
          destination: {
            service: "eve",
            type: "service",
          },
          src: "^/eve/v1/(.*)$",
        },
      ],
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && node 'node_modules/eve/bin/eve.js' build",
          framework: "eve",
          routes: [
            {
              src: "^/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve",
        },
      },
      version: 3,
    });
    expect(rewrites).toBeUndefined();
  });

  it("isolates a colocated generated eve service from the Next.js Build Output", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    await resolveConfig(withEve<TestConfig>({}));

    const serviceRoot = join(appRoot, ".eve", "vercel-services", "eve");
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect((await stat(serviceRoot)).isDirectory()).toBe(true);
    expect(outputConfig).toMatchObject({
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && node 'node_modules/eve/bin/eve.js' build",
          root: ".eve/vercel-services/eve",
        },
      },
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
      routes: [
        {
          destination: {
            service: "eve",
            type: "service",
          },
          src: "^/eve/v1/(.*)$",
        },
      ],
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && node 'node_modules/eve/bin/eve.js' build",
          framework: "eve",
          routes: [
            {
              src: "^/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve",
        },
      },
      version: 3,
    });
    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("uses an already configured root eve service", async () => {
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
          services: {
            agent: {
              entrypoint: "package.json",
              framework: "eve",
              root: "agent",
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
    expect(rewrites).toBeUndefined();
  });

  it("preserves an already configured Build Output eve service and inserts its route", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(join(appRoot, ".vercel", "project.json"), "{}\n");
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          routes: [
            { handle: "filesystem" },
            {
              destination: {
                service: "agent",
                type: "service",
              },
              src: "^/eve/v1/(.*)$",
            },
          ],
          services: {
            agent: {
              entrypoint: "package.json",
              framework: "eve",
              root: "agent",
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
      routes: [
        {
          destination: {
            service: "agent",
            type: "service",
          },
          src: "^/eve/v1/(.*)$",
        },
        { handle: "filesystem" },
      ],
      services: {
        agent: {
          entrypoint: "package.json",
          framework: "eve",
          routes: [
            {
              src: "^/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: "agent",
        },
      },
      version: 3,
    });
    expect(rewrites).toBeUndefined();
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
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && pnpm build:eve",
        },
      },
    });
  });

  it("writes one Build Output service and route for each named agent", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

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
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toEqual({
      routes: [
        {
          destination: {
            service: "eve-billing",
            type: "service",
          },
          src: "^/eve/agents/billing/eve/v1/(.*)$",
        },
        {
          destination: {
            service: "eve-support",
            type: "service",
          },
          src: "^/eve/agents/support/eve/v1/(.*)$",
        },
      ],
      services: {
        "eve-billing": {
          buildCommand:
            "cd '../../../agents/billing' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-billing/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && pnpm build:billing-agent",
          framework: "eve",
          routes: [
            {
              src: "^/eve/agents/billing/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve-billing",
          routePrefix: "/eve/agents/billing",
        },
        "eve-support": {
          buildCommand:
            "cd '../../../agents/support' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-support/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && node '../../node_modules/eve/bin/eve.js' build",
          framework: "eve",
          routes: [
            {
              src: "^/eve/agents/support/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve-support",
          routePrefix: "/eve/agents/support",
        },
      },
      version: 3,
    });
    expect(rewrites).toBeUndefined();
  });

  it("normalizes existing Build Output service arrays before adding named agents", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(join(appRoot, ".vercel", "project.json"), "{}\n");
    await writeFile(join(appRoot, ".vercel", "output", "builds.json"), "{}\n");
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          routes: [
            {
              destination: {
                service: "eve-billing",
                type: "service",
              },
              src: "^/eve/agents/billing/eve/v1/(.*)$",
            },
            { handle: "filesystem" },
          ],
          services: [
            {
              buildCommand: "eve build:support",
              entrypoint: "package.json",
              framework: "eve",
              name: "eve-support",
              root: "agents/support",
              routePrefix: "/eve/agents/support",
              schema: "experimentalServicesV2",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(
      withEve<TestConfig>(
        {},
        {
          agents: {
            billing: "./agents/billing",
            support: "./agents/support",
          },
        },
      ),
    );
    const rewrites = await config.rewrites?.();
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toEqual({
      routes: [
        {
          destination: {
            service: "eve-billing",
            type: "service",
          },
          src: "^/eve/agents/billing/eve/v1/(.*)$",
        },
        {
          destination: {
            service: "eve-support",
            type: "service",
          },
          src: "^/eve/agents/support/eve/v1/(.*)$",
        },
        { handle: "filesystem" },
      ],
      services: {
        "eve-billing": {
          buildCommand:
            "cd '../../../agents/billing' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-billing/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && node '../../node_modules/eve/bin/eve.js' build",
          framework: "eve",
          routes: [
            {
              src: "^/eve/agents/billing/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: ".eve/vercel-services/eve-billing",
          routePrefix: "/eve/agents/billing",
        },
        "eve-support": {
          buildCommand: "eve build:support",
          entrypoint: "package.json",
          framework: "eve",
          routes: [
            {
              src: "^/eve/agents/support/eve/v1/(.*)$",
              transforms: [
                {
                  args: "/eve/v1/$1",
                  op: "set",
                  type: "request.path",
                },
              ],
            },
          ],
          root: "agents/support",
          routePrefix: "/eve/agents/support",
          schema: "experimentalServicesV2",
        },
      },
      version: 3,
    });
    expect(rewrites).toBeUndefined();
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
