import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Nitro } from "nitro/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import {
  APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
  type ApplicationBuildProfile,
} from "#internal/application/build-profile.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";
import {
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
} from "#internal/vercel-agent-summary.js";

const buildNitroMock = vi.fn(async (nitro: Nitro) => {
  const outputDir = nitro.options.output.dir;
  const functionDirectory = join(outputDir, "functions", "__server.func");

  await mkdir(functionDirectory, { recursive: true });
  await writeFile(
    join(functionDirectory, ".vc-config.json"),
    `${JSON.stringify({ runtime: "nodejs24.x" }, null, 2)}\n`,
  );
  await writeFile(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      {
        routes: [
          { handle: "filesystem" },
          { dest: "/eve/v1/health", src: "/eve/v1/health" },
          {
            dest: "/eve/v1/session/[sessionId]/stream",
            src: "^/eve/v1/session/(?<sessionId>[^/]+)/stream$",
          },
          { dest: "/index", src: "/" },
          { dest: "/__server", src: "/(.*)" },
        ],
        version: 3,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(functionDirectory, "_runtime.mjs"), "export default {};\n");
  await mkdir(join(outputDir, "functions", "eve", "v1"), { recursive: true });
  await symlink("./__server.func", join(outputDir, "functions", "index.func"), "dir");
  await symlink(
    "./../../__server.func",
    join(outputDir, "functions", "eve", "v1", "health.func"),
    "dir",
  );
});
const copyPublicAssetsMock = vi.fn(async () => undefined);
const createProductionApplicationNitroMock = vi.fn();
const prepareProductionApplicationHostMock = vi.fn();
const prepareMock = vi.fn(async () => undefined);
const prerenderMock = vi.fn(async () => undefined);
const resolveDiscoveryProjectMock = vi.fn(async (appRoot: string) => ({
  agentRoot: join(appRoot, "agent"),
  appRoot,
  layout: "nested" as const,
}));
const runVercelBuildPrewarmMock = vi.fn(async () => undefined);
const workflowBuilderBuildVercelOutputMock = vi.fn(async (_options: unknown) => undefined);
const workflowBuilderConstructors: unknown[] = [];

vi.mock("nitro/builder", () => ({
  build: buildNitroMock,
  copyPublicAssets: copyPublicAssetsMock,
  prepare: prepareMock,
  prerender: prerenderMock,
}));

vi.mock("./create-application-nitro.js", () => ({
  createProductionApplicationNitro: createProductionApplicationNitroMock,
}));

vi.mock("./prepare-application-host.js", () => ({
  prepareProductionApplicationHost: prepareProductionApplicationHostMock,
}));

vi.mock("#discover/project.js", () => ({
  resolveDiscoveryProject: resolveDiscoveryProjectMock,
}));

vi.mock("./vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: runVercelBuildPrewarmMock,
}));

vi.mock("../../workflow-bundle/builder.js", () => ({
  WorkflowBundleBuilder: class WorkflowBundleBuilder {
    constructor(options: unknown) {
      workflowBuilderConstructors.push(options);
    }

    async buildVercelOutput(options: unknown): Promise<void> {
      await workflowBuilderBuildVercelOutputMock(options);
    }
  },
}));

const createScratchDirectory = useTemporaryDirectories();
const DEPLOYABLE_BUILD_OPTIONS = { skipVercelSandboxPrewarm: false } as const;

function createPreparedHost(appRoot: string): PreparedApplicationHost {
  const agentRoot = join(appRoot, "agent");
  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    config: {
      model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
      name: "scenario-test-agent",
    },
  });
  return {
    appRoot,
    compileResult: {
      manifest,
      paths: {
        compileDirectoryPath: join(
          appRoot,
          ".eve",
          "builds",
          "test",
          "compiler",
          ".eve",
          "compile",
        ),
      },
      project: {
        agentRoot,
        appRoot,
        layout: "nested",
      },
    } as unknown as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {
      bootstrapPath: join(appRoot, ".eve", "compile", "compiled-artifacts-bootstrap.mjs"),
      workflowWorldPluginPath: join(
        appRoot,
        ".eve",
        "compile",
        "compiled-artifacts-workflow-world.mjs",
      ),
    } as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(appRoot, ".eve", "workflow-cache"),
  };
}

function createNitroStub(outputDir: string): Nitro {
  return {
    close: vi.fn(async () => undefined),
    options: {
      output: {
        dir: outputDir,
      },
    },
  } as unknown as Nitro;
}

async function prepareHostBuildWorkspace(
  workspace: ApplicationBuildWorkspace,
): Promise<PreparedApplicationHost> {
  await mkdir(join(workspace.compiler.artifactsDir, "compile"), { recursive: true });
  return createPreparedHost(workspace.appRoot);
}

describe("buildApplication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    workflowBuilderConstructors.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds without publishing stable runtime compiler artifacts", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-single-");
    const outputDir = join(appRoot, ".output");
    const staleOutputPath = join(outputDir, "stale-output.txt");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementationOnce(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(join(outputDir, "eve-cache.json"), `${JSON.stringify({ eveVersion: "old" })}\n`),
      writeFile(staleOutputPath, "stale\n"),
    ]);

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    const builtOutputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(builtOutputDir).toBe(outputDir);
    expect(createProductionApplicationNitroMock).toHaveBeenCalledTimes(1);
    expect(createProductionApplicationNitroMock).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot }),
      expect.objectContaining({
        buildDir: expect.stringContaining(join(appRoot, ".eve", "builds")),
        outputDir: expect.stringContaining(join(appRoot, ".eve", "builds")),
      }),
    );
    await expect(readFile(staleOutputPath, "utf8")).rejects.toThrow();
    await expect(readFile(join(outputDir, "eve-cache.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          eveVersion: resolveInstalledPackageInfo().version,
        },
        null,
        2,
      )}\n`,
    );
    expect(workflowBuilderBuildVercelOutputMock).not.toHaveBeenCalled();
    expect(runVercelBuildPrewarmMock).not.toHaveBeenCalled();
    await expect(
      readFile(join(appRoot, ".eve", "compile", "compiled-agent-manifest.json"), "utf8"),
    ).rejects.toThrow();

    const summary = JSON.parse(
      await readFile(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("writes a versioned timing and output-size profile outside the published output", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-profile-");
    const profilePath = join(appRoot, ".eve", "profiles", "build.json");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementationOnce(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot, {
      profileOutputPath: profilePath,
      skipVercelSandboxPrewarm: false,
    });

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as ApplicationBuildProfile;

    expect(profile).toMatchObject({
      kind: "eve-build-profile",
      schemaVersion: APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
      target: "local",
    });
    expect(profile.durationMs).toBeGreaterThanOrEqual(0);
    expect(profile.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "host.prepare" }),
        expect.objectContaining({ name: "nitro.all.bundle" }),
        expect.objectContaining({ name: "output.publish" }),
        expect.objectContaining({ name: "workspace.remove" }),
      ]),
    );
    expect(profile.phases.every((phase) => phase.durationMs >= 0)).toBe(true);
    expect(profile.output.files).toBeGreaterThan(0);
    expect(profile.output.rawBytes).toBeGreaterThan(0);
    expect(profile.output.gzipBytes).toBeGreaterThan(0);
    expect(profile.output.functionBundles).toEqual([
      expect.objectContaining({
        files: 2,
        path: "functions/__server.func",
      }),
    ]);
  });

  it("rejects a profile path inside the published output", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-profile-output-");

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await expect(
      buildApplication(appRoot, {
        profileOutputPath: join(appRoot, ".output", "build-profile.json"),
        skipVercelSandboxPrewarm: false,
      }),
    ).rejects.toThrow("must be outside the published output directory");

    expect(prepareProductionApplicationHostMock).not.toHaveBeenCalled();
  });

  it("keeps the last-good output when Nitro mutates its target before failing", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-last-good-");
    const outputDir = join(appRoot, ".output");
    const summaryPath = join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH);
    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementationOnce(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    buildNitroMock.mockImplementationOnce(async (nitro: Nitro) => {
      await mkdir(nitro.options.output.dir, { recursive: true });
      await writeFile(join(nitro.options.output.dir, "marker.txt"), "partial-failed-output\n");
      throw new Error("injected Nitro build failure");
    });
    await Promise.all([
      mkdir(outputDir, { recursive: true }),
      mkdir(join(summaryPath, ".."), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(outputDir, "marker.txt"), "last-good-output\n"),
      writeFile(
        join(outputDir, "eve-cache.json"),
        `${JSON.stringify({ eveVersion: resolveInstalledPackageInfo().version }, null, 2)}\n`,
      ),
      writeFile(summaryPath, "last-good-summary\n"),
    ]);

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      "injected Nitro build failure",
    );

    await expect(readFile(join(outputDir, "marker.txt"), "utf8")).resolves.toBe(
      "last-good-output\n",
    );
    await expect(readFile(summaryPath, "utf8")).resolves.toBe("last-good-summary\n");
  });

  it("builds isolated Vercel Nitro surfaces and stitches workflow functions", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-");
    const stableFlowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");
    const staleFlowOutputPath = join(stableFlowOutputDir, "stale-flow.txt");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await mkdir(stableFlowOutputDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(stableFlowOutputDir, "eve-cache.json"),
        `${JSON.stringify({ eveVersion: "old" })}\n`,
      ),
      writeFile(staleFlowOutputPath, "stale\n"),
      mkdir(join(appRoot, ".vercel", "output"), { recursive: true }),
    ]);
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          experimentalServices: {
            eve: {
              entrypoint: ".",
              framework: "eve",
              mount: "/_eve_internal/eve",
              type: "web",
            },
            web: {
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

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    expect(createProductionApplicationNitroMock).toHaveBeenCalledTimes(2);
    expect(createProductionApplicationNitroMock.mock.calls.map((call) => call[1]?.surface)).toEqual(
      ["app", "flow"],
    );
    const flowOutputDir = createProductionApplicationNitroMock.mock.calls.find(
      (call) => call[1]?.surface === "flow",
    )?.[1]?.outputDir;
    expect(flowOutputDir).toEqual(expect.stringContaining(join(appRoot, ".eve", "builds")));
    expect(workflowBuilderConstructors).toHaveLength(1);
    expect(workflowBuilderBuildVercelOutputMock).toHaveBeenCalledWith({
      flowNitroOutputDir: flowOutputDir,
      outputDir: expect.stringContaining(join(appRoot, ".eve", "builds")),
      runtime: "nodejs24.x",
    });
    const nestedFunctionStats = await lstat(
      join(appRoot, ".vercel", "output", "functions", "eve", "v1", "health.func"),
    );
    const sharedFunctionStats = await lstat(
      join(appRoot, ".vercel", "output", "functions", "eve", "__server.func"),
    );
    const vercelConfig = JSON.parse(
      await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };

    await expect(
      lstat(join(appRoot, ".vercel", "output", "functions", "index.func")),
    ).rejects.toThrow();
    await expect(
      lstat(join(appRoot, ".vercel", "output", "functions", "__server.func")),
    ).rejects.toThrow();
    expect(sharedFunctionStats.isDirectory()).toBe(true);
    expect(sharedFunctionStats.isSymbolicLink()).toBe(false);
    expect(nestedFunctionStats.isSymbolicLink()).toBe(true);
    await expect(
      realpath(join(appRoot, ".vercel", "output", "functions", "eve", "v1", "health.func")),
    ).resolves.toBe(
      await realpath(join(appRoot, ".vercel", "output", "functions", "eve", "__server.func")),
    );
    await expect(
      readFile(
        join(appRoot, ".vercel", "output", "functions", "eve", "v1", "health.func", "_runtime.mjs"),
        "utf8",
      ),
    ).resolves.toContain("export default");
    expect(vercelConfig.routes).toEqual([
      { handle: "filesystem" },
      { dest: "/eve/__server", src: "/eve/v1/health" },
      {
        dest: "/eve/__server",
        src: "^/eve/v1/session/(?<sessionId>[^/]+)/stream$",
      },
    ]);
    await expect(readFile(staleFlowOutputPath, "utf8")).resolves.toBe("stale\n");
    expect(runVercelBuildPrewarmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
        compiledArtifactsSource: expect.objectContaining({
          kind: "disk",
          sandboxAppRoot: appRoot,
        }),
        log: expect.any(Function),
      }),
    );

    const summary = JSON.parse(
      await readFile(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("skips Vercel sandbox prewarm only when the build opts out", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-skip-prewarm-");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    const outputDir = await buildApplication(appRoot, {
      skipVercelSandboxPrewarm: true,
    });

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    expect(runVercelBuildPrewarmMock).not.toHaveBeenCalled();
    expect(workflowBuilderBuildVercelOutputMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes eve function output behind a non-Next host service", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-nuxt-");
    const flowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await mkdir(flowOutputDir, { recursive: true });
    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify(
        {
          experimentalServices: {
            eve: {
              entrypoint: ".",
              framework: "eve",
              routePrefix: "/_eve_internal/eve",
            },
            web: {
              entrypoint: ".",
              framework: "nuxtjs",
              routePrefix: "/",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    const sharedFunctionStats = await lstat(
      join(appRoot, ".vercel", "output", "functions", "eve", "__server.func"),
    );

    expect(sharedFunctionStats.isDirectory()).toBe(true);
    expect(sharedFunctionStats.isSymbolicLink()).toBe(false);
    await expect(
      lstat(join(appRoot, ".vercel", "output", "functions", "__server.func")),
    ).rejects.toThrow();
    await expect(
      lstat(join(appRoot, ".vercel", "output", "functions", "index.func")),
    ).rejects.toThrow();
    const vercelConfig = JSON.parse(
      await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };
    expect(vercelConfig.routes).toContainEqual({
      dest: "/eve/__server",
      src: "/eve/v1/health",
    });
  });

  it("normalizes eve function output behind a host service from a service array", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-service-array-");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          services: [
            {
              entrypoint: "package.json",
              framework: "nextjs",
              name: "web",
              root: ".",
            },
            {
              entrypoint: "package.json",
              framework: "eve",
              name: "eve-support",
              root: ".",
              routePrefix: "/eve/agents/support",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    const vercelConfig = JSON.parse(
      await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };
    expect(vercelConfig.routes).toContainEqual({
      dest: "/eve/__server",
      src: "/eve/v1/health",
    });
  });

  it("resolves service roots relative to a linked Vercel root directory", async () => {
    vi.stubEnv("VERCEL", "1");
    const projectRoot = await createScratchDirectory("eve-build-application-vercel-root-dir-");
    const appRoot = join(projectRoot, "apps", "web", "agents", "support");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await mkdir(join(projectRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      `${JSON.stringify(
        {
          settings: {
            rootDirectory: "apps/web",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(projectRoot, ".vercel", "output", "builds.json"), "{}\n");
    await writeFile(
      join(projectRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          experimentalServicesV2: {
            web: {
              framework: "nextjs",
              root: ".",
            },
            "eve-support": {
              framework: "eve",
              root: "agents/support",
              routePrefix: "/eve/agents/support",
            },
          },
          version: 3,
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    const vercelConfig = JSON.parse(
      await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };
    expect(vercelConfig.routes).toContainEqual({
      dest: "/eve/__server",
      src: "/eve/v1/health",
    });
  });

  it("builds isolated Vercel Nitro surfaces from legacy root service config", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-root-config-");
    const flowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );
    await Promise.all([
      mkdir(flowOutputDir, { recursive: true }),
      writeFile(
        join(appRoot, "vercel.json"),
        `${JSON.stringify(
          {
            experimentalServices: {
              eve: {
                entrypoint: ".",
                framework: "eve",
                routePrefix: "/_eve_internal/eve",
              },
              web: {
                entrypoint: ".",
                framework: "nextjs",
                routePrefix: "/",
              },
            },
          },
          null,
          2,
        )}\n`,
      ),
    ]);

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    const vercelConfig = JSON.parse(
      await readFile(join(appRoot, ".vercel", "output", "config.json"), "utf8"),
    ) as {
      routes: unknown[];
    };
    expect(vercelConfig.routes).toContainEqual({
      dest: "/eve/__server",
      src: "/eve/v1/health",
    });
  });

  it("leaves standalone Vercel Nitro output routable at the root", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-standalone-");

    prepareProductionApplicationHostMock.mockImplementationOnce(prepareHostBuildWorkspace);
    createProductionApplicationNitroMock.mockImplementation(
      async (_preparedHost: PreparedApplicationHost, options: { outputDir: string }) =>
        createNitroStub(options.outputDir),
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    const rootFunctionStats = await lstat(
      join(appRoot, ".vercel", "output", "functions", "index.func"),
    );
    const sharedFunctionStats = await lstat(
      join(appRoot, ".vercel", "output", "functions", "__server.func"),
    );

    expect(rootFunctionStats.isSymbolicLink()).toBe(true);
    expect(sharedFunctionStats.isDirectory()).toBe(true);
    await expect(
      readFile(
        join(appRoot, ".vercel", "output", "functions", "index.func", "_runtime.mjs"),
        "utf8",
      ),
    ).resolves.toContain("export default");
  });
});
