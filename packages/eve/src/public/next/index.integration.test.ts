import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#shared/resolve-eve-binary.js", async () => {
  const { join } = await import("node:path");
  return {
    // Pin resolution to the conventional app-local path so build-command
    // assertions stay deterministic without a real eve install on disk. The
    // real resolver is exercised in resolve-eve-binary.integration.test.ts.
    resolveEveBinaryPath: (nextRoot: string) =>
      join(nextRoot, "node_modules", "eve", "bin", "eve.js"),
  };
});

interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

const spawnMock = vi.hoisted(() =>
  vi.fn<(command: string, args: readonly string[], options: SpawnOptions) => EventEmitter>(),
);

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

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
    spawnMock.mockReset();
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires a local eve build when next start loads config outside Vercel", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      withEve<TestConfig>({})("phase-production-server", { defaultConfig: {} }),
    ).rejects.toThrow(/Run eve build from .+ before starting Next\.js\./u);
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(
      readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("starts each managed agent once when next start loads config, without rewrites()", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    const resolvedAppRoot = process.cwd();
    vi.stubEnv("NODE_ENV", "production");
    await writeBuiltAgent(join(resolvedAppRoot, "agents", "billing"));
    await writeBuiltAgent(join(resolvedAppRoot, "agents", "support"));
    spawnListeningServer();
    const config = withEve<TestConfig>(
      {},
      { agents: { billing: "./agents/billing", support: "./agents/support" } },
    );

    await config("phase-production-server", { defaultConfig: {} });
    expect(spawnedServers()).toEqual([
      { cwd: join(resolvedAppRoot, "agents", "billing"), port: "4274" },
      { cwd: join(resolvedAppRoot, "agents", "support"), port: "4275" },
    ]);

    const reloaded = await config("phase-production-server", { defaultConfig: {} });
    const rewrites = await reloaded.rewrites?.();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(getBeforeFiles(rewrites)).toEqual([
      { destination: "http://127.0.0.1:4274/eve/v1/:path+", source: "/eve/billing/v1/:path+" },
      { destination: "http://127.0.0.1:4275/eve/v1/:path+", source: "/eve/support/v1/:path+" },
    ]);
  });

  it("starts one managed server per port when named agents share a root", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    const sharedRoot = join(process.cwd(), "agents", "shared");
    vi.stubEnv("NODE_ENV", "production");
    await writeBuiltAgent(sharedRoot);
    spawnListeningServer();
    const config = withEve<TestConfig>(
      {},
      { agents: { billing: "./agents/shared", support: "./agents/shared" } },
    );

    await config("phase-production-server", { defaultConfig: {} });
    const reloaded = await config("phase-production-server", { defaultConfig: {} });
    const rewrites = await reloaded.rewrites?.();

    expect(spawnedServers()).toEqual([
      { cwd: sharedRoot, port: "4274" },
      { cwd: sharedRoot, port: "4275" },
    ]);
    expect(getBeforeFiles(rewrites)).toEqual([
      { destination: "http://127.0.0.1:4274/eve/v1/:path+", source: "/eve/billing/v1/:path+" },
      { destination: "http://127.0.0.1:4275/eve/v1/:path+", source: "/eve/support/v1/:path+" },
    ]);
  });

  it("stops a managed agent that cannot bind its port instead of waiting for its URL", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    await writeBuiltAgent(process.cwd());
    const kill = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        kill,
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
      });
      setImmediate(() => {
        child.stderr.emit(
          "data",
          Buffer.from(
            "[srvx] Failed to start server: Error: listen EADDRINUSE: address already in use 127.0.0.1:4274\n",
          ),
        );
      });
      return child;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      withEve<TestConfig>({})("phase-production-server", { defaultConfig: {} }),
    ).rejects.toThrow(
      "Port 4274 on 127.0.0.1 is already in use. Another process is listening there; stop it or set EVE_NEXT_PRODUCTION_PORT to another port.",
    );
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not start a managed agent on Vercel, for a hosted origin, or while building", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    await writeBuiltAgent(process.cwd());
    spawnListeningServer();

    await withEve<TestConfig>({})("phase-production-build", { defaultConfig: {} });
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "https://agent.example.com");
    await withEve<TestConfig>({})("phase-production-server", { defaultConfig: {} });
    vi.stubEnv("EVE_NEXT_PRODUCTION_ORIGIN", "");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    await withEve<TestConfig>({})("phase-production-server", { defaultConfig: {} });

    expect(spawnMock).not.toHaveBeenCalled();
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
          outputDirectory: ".vercel/output",
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

  it("writes fallback Build Output config under the app in a linked monorepo", async () => {
    const projectRoot = await createTempAppRoot();
    const appRoot = join(projectRoot, "apps", "web");
    await mkdir(join(projectRoot, ".vercel"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      JSON.stringify({ settings: { rootDirectory: "apps/web" } }),
    );
    await mkdir(join(projectRoot, "custom-staging"));
    await writeFile(join(projectRoot, "custom-staging", "builds.json"), "{}\n");
    await mkdir(appRoot, { recursive: true });
    process.chdir(appRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    await resolveConfig(withEve<TestConfig>({}));

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
          outputDirectory: ".vercel/output",
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
      readFile(join(projectRoot, ".vercel", "output", "config.json"), "utf8"),
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

  it("discovers workspace agents when the Next.js app owns the workspace", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    await Promise.all([
      mkdir(join(appRoot, "agents", "support", "agent"), { recursive: true }),
      mkdir(join(appRoot, "agents", "research", "agent"), { recursive: true }),
      writeFile(join(appRoot, "package.json"), JSON.stringify({ dependencies: { eve: "*" } })),
    ]);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    const config = await resolveConfig(withEve<TestConfig>({}));
    const rewrites = await config.rewrites?.();
    const outputConfig = await readJsonFile(join(appRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({
          destination: { service: "eve-research", type: "service" },
          src: "^/eve/research/v1/(.*)$",
        }),
        expect.objectContaining({
          destination: { service: "eve-support", type: "service" },
          src: "^/eve/support/v1/(.*)$",
        }),
        expect.objectContaining({
          destination: { service: "eve-research", type: "service" },
          src: "^/eve/research/?$",
        }),
        expect.objectContaining({
          destination: { service: "eve-support", type: "service" },
          src: "^/eve/support/?$",
        }),
      ]),
      services: expect.objectContaining({
        "eve-research": expect.objectContaining({
          buildCommand: expect.stringContaining("EVE_INTERNAL_AGENT_WORKSPACE_MEMBER=1"),
          routePrefix: "/eve/research",
        }),
        "eve-support": expect.objectContaining({
          buildCommand: expect.stringContaining("EVE_INTERNAL_AGENT_WORKSPACE_MEMBER=1"),
          routePrefix: "/eve/support",
        }),
      }),
    });
    expect(rewrites).toBeUndefined();
  });

  it("discovers a peer workspace through eveRoot", async () => {
    const workspaceRoot = await createTempAppRoot();
    const nextRoot = join(workspaceRoot, "apps", "web");
    await Promise.all([
      mkdir(join(workspaceRoot, "agents", "support", "agent"), { recursive: true }),
      mkdir(join(workspaceRoot, "agents", "research", "agent"), { recursive: true }),
      mkdir(nextRoot, { recursive: true }),
      writeFile(
        join(workspaceRoot, "package.json"),
        JSON.stringify({ dependencies: { eve: "*" } }),
      ),
    ]);
    process.chdir(nextRoot);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "preview.example.com");

    await resolveConfig(withEve<TestConfig>({}, { eveRoot: "../.." }));
    const outputConfig = await readJsonFile(join(nextRoot, ".vercel", "output", "config.json"));

    expect(outputConfig).toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({ src: "^/eve/research/v1/(.*)$" }),
        expect.objectContaining({ src: "^/eve/support/v1/(.*)$" }),
      ]),
      services: expect.objectContaining({
        "eve-research": expect.objectContaining({ routePrefix: "/eve/research" }),
        "eve-support": expect.objectContaining({ routePrefix: "/eve/support" }),
      }),
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
      services: {
        eve: {
          buildCommand:
            "cd '../../..' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='.eve/vercel-services/eve/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='.vercel/output' && pnpm build:eve",
        },
      },
    });
  });

  it("discovers workspace members from an absolute eveRoot with a trailing slash", async () => {
    const appRoot = await createTempAppRoot();
    process.chdir(appRoot);
    await mkdir(join(appRoot, "agents", "a", "agent"), { recursive: true });
    await mkdir(join(appRoot, "agents", "b", "agent"), { recursive: true });
    await writeFile(
      join(appRoot, "package.json"),
      `${JSON.stringify({ dependencies: { eve: "0.0.0" } })}\n`,
    );
    await writeFile(join(appRoot, "agents", "a", "agent", "agent.ts"), "export default {};\n");
    await writeFile(join(appRoot, "agents", "b", "agent", "agent.ts"), "export default {};\n");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");

    await resolveConfig(withEve<TestConfig>({}, { eveRoot: `${appRoot}/` }));
    const outputConfig = (await readJsonFile(
      join(appRoot, ".vercel", "output", "config.json"),
    )) as { services?: Record<string, unknown> };

    expect(Object.keys(outputConfig.services ?? {})).toEqual(["eve-a", "eve-b"]);
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
          src: "^/eve/billing/v1/(.*)$",
        },
        {
          destination: {
            service: "eve-support",
            type: "service",
          },
          src: "^/eve/support/v1/(.*)$",
        },
      ],
      services: {
        "eve-billing": {
          buildCommand:
            "cd '../../../agents/billing' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-billing/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && export EVE_PUBLIC_ROUTE_PREFIX='/eve/billing' && pnpm build:billing-agent",
          framework: "eve",
          outputDirectory: ".vercel/output",
          routes: [
            {
              src: "^/eve/billing/v1/(.*)$",
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
          routePrefix: "/eve/billing",
        },
        "eve-support": {
          buildCommand:
            "cd '../../../agents/support' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-support/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && export EVE_PUBLIC_ROUTE_PREFIX='/eve/support' && node 'node_modules/eve/bin/eve.js' build",
          framework: "eve",
          outputDirectory: ".vercel/output",
          routes: [
            {
              src: "^/eve/support/v1/(.*)$",
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
          routePrefix: "/eve/support",
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
              src: "^/eve/billing/v1/(.*)$",
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
              routePrefix: "/eve/support",
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
          src: "^/eve/billing/v1/(.*)$",
        },
        {
          destination: {
            service: "eve-support",
            type: "service",
          },
          src: "^/eve/support/v1/(.*)$",
        },
        { handle: "filesystem" },
      ],
      services: {
        "eve-billing": {
          buildCommand:
            "cd '../../../agents/billing' && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY='../../.eve/vercel-services/eve-billing/.vercel/output' && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY='../../.vercel/output' && export EVE_PUBLIC_ROUTE_PREFIX='/eve/billing' && node 'node_modules/eve/bin/eve.js' build",
          framework: "eve",
          outputDirectory: ".vercel/output",
          routes: [
            {
              src: "^/eve/billing/v1/(.*)$",
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
          routePrefix: "/eve/billing",
        },
        "eve-support": {
          buildCommand: "eve build:support",
          entrypoint: "package.json",
          framework: "eve",
          routes: [
            {
              src: "^/eve/support/v1/(.*)$",
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
          routePrefix: "/eve/support",
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
      vi.fn(async () => Response.json({ revision: "rev-1" })),
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

    expect(fetch).toHaveBeenCalledWith(
      new URL("/eve/v1/dev/runtime-artifacts", "http://127.0.0.1:49152"),
      { redirect: "error", signal: expect.any(AbortSignal) },
    );
    expect(getBeforeFiles(rewrites)).toContainEqual({
      destination: "http://127.0.0.1:49152/eve/v1/:path+",
      source: "/eve/v1/:path+",
    });
  });
});

async function writeBuiltAgent(agentRoot: string): Promise<void> {
  await mkdir(join(agentRoot, ".output", "server"), { recursive: true });
  await writeFile(join(agentRoot, ".output", "server", "index.mjs"), "// built agent\n");
}

/** Each spawned child reports it is listening on the port it was given. */
function spawnListeningServer(): void {
  spawnMock.mockImplementation((_command, _args, options) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill: () => undefined,
      pid: 12345,
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    setImmediate(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`Listening on: http://127.0.0.1:${options.env.PORT ?? ""}/\n`),
      );
    });
    return child;
  });
}

function spawnedServers(): readonly { readonly cwd: string; readonly port: string }[] {
  return spawnMock.mock.calls.map(([, , options]) => ({
    cwd: options.cwd,
    port: options.env.PORT ?? "",
  }));
}

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
