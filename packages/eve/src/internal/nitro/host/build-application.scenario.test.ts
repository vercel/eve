import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Nitro } from "nitro/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
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
const createApplicationNitroMock = vi.fn();
const prepareApplicationHostMock = vi.fn();
const prepareMock = vi.fn(async () => undefined);
const prerenderMock = vi.fn(async () => undefined);
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
  createApplicationNitro: createApplicationNitroMock,
}));

vi.mock("./prepare-application-host.js", () => ({
  prepareApplicationHost: prepareApplicationHostMock,
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
      project: {
        agentRoot,
        appRoot,
        layout: "nested",
      },
    } as unknown as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {
      bootstrapPath: join(appRoot, ".eve", "compile", "compiled-artifacts-bootstrap.mjs"),
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

describe("buildApplication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    workflowBuilderConstructors.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a single Nitro host outside Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-single-");
    const outputDir = join(appRoot, ".output");
    const staleOutputPath = join(outputDir, "stale-output.txt");

    prepareApplicationHostMock.mockResolvedValueOnce(createPreparedHost(appRoot));
    createApplicationNitroMock.mockResolvedValueOnce(createNitroStub(outputDir));
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(join(outputDir, "eve-cache.json"), `${JSON.stringify({ eveVersion: "old" })}\n`),
      writeFile(staleOutputPath, "stale\n"),
    ]);

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    const builtOutputDir = await buildApplication(appRoot);

    expect(builtOutputDir).toBe(outputDir);
    expect(createApplicationNitroMock).toHaveBeenCalledTimes(1);
    expect(createApplicationNitroMock).toHaveBeenCalledWith(
      expect.objectContaining({ appRoot }),
      false,
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

    const summary = JSON.parse(
      await readFile(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("builds isolated Vercel Nitro surfaces and stitches workflow functions", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-");
    const flowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");
    const staleFlowOutputPath = join(flowOutputDir, "stale-flow.txt");

    prepareApplicationHostMock.mockResolvedValueOnce(createPreparedHost(appRoot));
    createApplicationNitroMock.mockImplementation(
      async (
        _preparedHost: PreparedApplicationHost,
        _dev: boolean,
        options: { outputDir?: string; surface?: string } = {},
      ) => {
        if (options.surface === "app") {
          return createNitroStub(join(appRoot, ".vercel", "output"));
        }

        return createNitroStub(options.outputDir ?? join(appRoot, ".output"));
      },
    );
    await mkdir(flowOutputDir, { recursive: true });
    await Promise.all([
      writeFile(
        join(flowOutputDir, "eve-cache.json"),
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
    const outputDir = await buildApplication(appRoot);

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    expect(createApplicationNitroMock).toHaveBeenCalledTimes(2);
    expect(createApplicationNitroMock.mock.calls.map((call) => call[2]?.surface ?? "all")).toEqual([
      "app",
      "flow",
    ]);
    expect(workflowBuilderConstructors).toHaveLength(1);
    expect(workflowBuilderBuildVercelOutputMock).toHaveBeenCalledWith({
      flowNitroOutputDir: flowOutputDir,
      outputDir: join(appRoot, ".vercel", "output"),
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
      routes: Array<{ dest?: string; handle?: string; src?: string }>;
    };
    const sharedFunctionConfig = JSON.parse(
      await readFile(
        join(appRoot, ".vercel", "output", "functions", "eve", "__server.func", ".vc-config.json"),
        "utf8",
      ),
    ) as { handler?: string };

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
      { dest: "/eve/__server", src: "/_eve_internal/eve/eve/v1/health" },
      {
        dest: "/eve/__server",
        src: "^/_eve_internal/eve/eve/v1/session/(?<sessionId>[^/]+)/stream$",
      },
    ]);
    expect(sharedFunctionConfig.handler).toBe("index.__eve_service_route_prefix.mjs");
    const sharedFunctionWrapper = await readFile(
      join(
        appRoot,
        ".vercel",
        "output",
        "functions",
        "eve",
        "__server.func",
        "index.__eve_service_route_prefix.mjs",
      ),
      "utf8",
    );
    expect(sharedFunctionWrapper).toContain('const SERVICE_PREFIX = "/_eve_internal/eve";');
    expect(sharedFunctionWrapper).toContain('event === "request" || event === "upgrade"');
    expect(sharedFunctionWrapper).toContain(
      "export const handleUpgrade = originalModule.handleUpgrade",
    );
    await expect(readFile(staleFlowOutputPath, "utf8")).rejects.toThrow();
    expect(runVercelBuildPrewarmMock).toHaveBeenCalledWith({
      appRoot,
      log: expect.any(Function),
    });

    const summary = JSON.parse(
      await readFile(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("normalizes eve function output behind a non-Next host service", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-nuxt-");
    const flowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");

    prepareApplicationHostMock.mockResolvedValueOnce(createPreparedHost(appRoot));
    createApplicationNitroMock.mockImplementation(
      async (
        _preparedHost: PreparedApplicationHost,
        _dev: boolean,
        options: { outputDir?: string; surface?: string } = {},
      ) => {
        if (options.surface === "app") {
          return createNitroStub(join(appRoot, ".vercel", "output"));
        }

        return createNitroStub(options.outputDir ?? join(appRoot, ".output"));
      },
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
    await buildApplication(appRoot);

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
    const sharedFunctionConfig = JSON.parse(
      await readFile(
        join(appRoot, ".vercel", "output", "functions", "eve", "__server.func", ".vc-config.json"),
        "utf8",
      ),
    ) as { handler?: string };
    expect(sharedFunctionConfig.handler).toBe("index.__eve_service_route_prefix.mjs");
  });

  it("builds isolated Vercel Nitro surfaces from legacy root service config", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-root-config-");
    const flowOutputDir = join(appRoot, ".eve", "nitro-output", "flow");

    prepareApplicationHostMock.mockResolvedValueOnce(createPreparedHost(appRoot));
    createApplicationNitroMock.mockImplementation(
      async (
        _preparedHost: PreparedApplicationHost,
        _dev: boolean,
        options: { outputDir?: string; surface?: string } = {},
      ) => {
        if (options.surface === "app") {
          return createNitroStub(join(appRoot, ".vercel", "output"));
        }

        return createNitroStub(options.outputDir ?? join(appRoot, ".output"));
      },
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
    const outputDir = await buildApplication(appRoot);

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    const sharedFunctionConfig = JSON.parse(
      await readFile(
        join(appRoot, ".vercel", "output", "functions", "eve", "__server.func", ".vc-config.json"),
        "utf8",
      ),
    ) as { handler?: string };
    expect(sharedFunctionConfig.handler).toBe("index.__eve_service_route_prefix.mjs");
    await expect(
      readFile(
        join(
          appRoot,
          ".vercel",
          "output",
          "functions",
          "eve",
          "__server.func",
          "index.__eve_service_route_prefix.mjs",
        ),
        "utf8",
      ),
    ).resolves.toContain('const SERVICE_PREFIX = "/_eve_internal/eve";');
  });

  it("leaves standalone Vercel Nitro output routable at the root", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-standalone-");

    prepareApplicationHostMock.mockResolvedValueOnce(createPreparedHost(appRoot));
    createApplicationNitroMock.mockImplementation(
      async (
        _preparedHost: PreparedApplicationHost,
        _dev: boolean,
        options: { outputDir?: string; surface?: string } = {},
      ) => {
        if (options.surface === "app") {
          return createNitroStub(join(appRoot, ".vercel", "output"));
        }

        return createNitroStub(options.outputDir ?? join(appRoot, ".output"));
      },
    );

    const { buildApplication } = await import("#internal/nitro/host/build-application.js");
    await buildApplication(appRoot);

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
