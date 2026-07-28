import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NitroConfig, Nitro } from "nitro/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import {
  EVE_CALLBACK_ROUTE_PATTERN,
  EVE_CANCEL_TURN_ROUTE_PATTERN,
  EVE_CONNECTION_CALLBACK_ROUTE_PATTERN,
  EVE_CONTINUE_SESSION_ROUTE_PATTERN,
  EVE_CREATE_SESSION_ROUTE_PATH,
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
  EVE_MESSAGE_STREAM_ROUTE_PATTERN,
  EVE_RESET_SESSION_ROUTE_PATH,
} from "#protocol/routes.js";
import type {
  NitroBuildSurface,
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";

const createNitroMock = vi.hoisted(() => vi.fn());
const workflowBuilderBuild = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("nitro/builder", () => ({
  createNitro: createNitroMock,
}));

vi.mock("#internal/workflow-bundle/builder.js", () => ({
  WorkflowBundleBuilder: class {
    build = workflowBuilderBuild;
  },
}));

const APPLICATION_ROUTE_KEYS = [
  `GET ${EVE_HEALTH_ROUTE_PATH}`,
  `HEAD ${EVE_HEALTH_ROUTE_PATH}`,
  `GET ${EVE_INFO_ROUTE_PATH}`,
  `POST ${EVE_CREATE_SESSION_ROUTE_PATH}`,
  `POST ${EVE_CONTINUE_SESSION_ROUTE_PATTERN}`,
  `POST ${EVE_CANCEL_TURN_ROUTE_PATTERN}`,
  `GET ${EVE_MESSAGE_STREAM_ROUTE_PATTERN}`,
  `GET ${EVE_CONNECTION_CALLBACK_ROUTE_PATTERN}`,
  `POST ${EVE_CONNECTION_CALLBACK_ROUTE_PATTERN}`,
  `POST ${EVE_CALLBACK_ROUTE_PATTERN}`,
  `POST ${EVE_RESET_SESSION_ROUTE_PATH}`,
].sort();
const WORKFLOW_ROUTE_KEY = "ALL /.well-known/workflow/v1/flow";
const tempRoots: string[] = [];

function createNitroStub(config: NitroConfig): Nitro {
  const hookHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const hook = vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
    hookHandlers.set(name, [...(hookHandlers.get(name) ?? []), handler]);
  });

  return Object.assign({} as Nitro, {
    close: vi.fn(async () => {}),
    hooks: { hook },
    options: {
      ...config,
      alias: { ...config.alias },
      buildDir: config.buildDir,
      dev: config.dev,
      handlers: [...(config.handlers ?? [])],
      rootDir: config.rootDir,
      scheduledTasks: { ...config.scheduledTasks },
      tasks: { ...config.tasks },
      virtual: { ...config.virtual },
    },
    routing: {
      sync: vi.fn(),
    },
  });
}

function createPreparedHost(appRoot: string): PreparedDevelopmentApplicationHost {
  const agentRoot = join(appRoot, "agent");
  const paths = resolveCompilerArtifactPaths(appRoot);
  const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "test");

  return {
    appRoot,
    compileResult: {
      diagnostics: [],
      manifest: createCompiledAgentManifest({
        agentRoot,
        appRoot,
        config: {
          model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
          name: "weather-agent",
        },
      }),
      metadata: {
        compile: {
          moduleMap: { path: paths.moduleMapPath, sha256: "module-map-sha" },
        },
        discovery: {
          diagnostics: { path: paths.diagnosticsPath, sha256: "diagnostics-sha" },
          manifest: { path: paths.discoveryManifestPath, sha256: "manifest-sha" },
          sourceGraphHash: "source-graph-sha",
          summary: { errors: 0, warnings: 0 },
        },
        generator: { name: "test", version: "0.0.0" },
        kind: COMPILE_METADATA_KIND,
        status: "ready",
        version: COMPILE_METADATA_VERSION,
      },
      paths,
      project: { agentRoot, appRoot, layout: "nested" },
    },
    compiledArtifacts: {
      bootstrapPath: join(appRoot, ".eve", "bootstrap.mjs"),
      workflowWorldPluginPath: join(appRoot, ".eve", "workflow-world.mjs"),
    } as PreparedApplicationHost["compiledArtifacts"],
    generation: {
      fingerprint: "runtime-fingerprint",
      runtimeAppRoot: join(workspaceRoot, "snapshot", "source", "app"),
      snapshotRoot: join(workspaceRoot, "snapshot"),
      snapshotSourceRoot: join(workspaceRoot, "snapshot", "source"),
      sourceRoot: appRoot,
    },
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(workspaceRoot, "workflow"),
    workspace: {
      artifactsDir: join(workspaceRoot, "artifacts"),
      compilerArtifactsDir: join(workspaceRoot, "compiler"),
      nitroBuildDir: join(workspaceRoot, "nitro"),
      nitroOutputDir: join(workspaceRoot, "output"),
      rootDir: workspaceRoot,
      workflowBuildDir: join(workspaceRoot, "workflow"),
    },
    workspaceExtensions: [],
  };
}

function getRouteKeys(nitro: Nitro): string[] {
  return nitro.options.handlers
    .map((handler) => `${handler.method ?? "ALL"} ${handler.route}`)
    .sort();
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("standalone Nitro constructor route composition", () => {
  it("returns a development candidate with the complete standalone route surface", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-nitro-dev-routes-"));
    tempRoots.push(appRoot);
    createNitroMock.mockImplementationOnce(async (config: NitroConfig) => createNitroStub(config));

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const nitro = await createDevelopmentApplicationNitro(createPreparedHost(appRoot));

    expect(getRouteKeys(nitro)).toEqual(
      [
        "GET /",
        ...APPLICATION_ROUTE_KEYS,
        `GET ${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}`,
        `POST ${EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN}`,
        WORKFLOW_ROUTE_KEY,
      ].sort(),
    );
    expect(nitro.routing.sync).toHaveBeenCalledOnce();
  });

  it.each<{
    expectedRoutes: string[];
    surface: NitroBuildSurface;
  }>([
    {
      expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS, WORKFLOW_ROUTE_KEY],
      surface: "all",
    },
    { expectedRoutes: ["GET /", ...APPLICATION_ROUTE_KEYS], surface: "app" },
    { expectedRoutes: [WORKFLOW_ROUTE_KEY], surface: "flow" },
  ])(
    "returns the complete standalone production $surface route surface",
    async ({ expectedRoutes, surface }) => {
      const appRoot = await mkdtemp(join(tmpdir(), `eve-nitro-${surface}-routes-`));
      tempRoots.push(appRoot);
      createNitroMock.mockImplementationOnce(async (config: NitroConfig) =>
        createNitroStub(config),
      );

      const { createProductionApplicationNitro } =
        await import("#internal/nitro/host/create-application-nitro.js");
      const preparedHost = createPreparedHost(appRoot);
      const nitro = await createProductionApplicationNitro(preparedHost, {
        buildDir: join(appRoot, ".eve", `nitro-${surface}`),
        outputDir: join(appRoot, ".output"),
        surface,
      });

      expect(getRouteKeys(nitro)).toEqual([...expectedRoutes].sort());
      expect(nitro.routing.sync).toHaveBeenCalledOnce();
    },
  );

  it("closes an unmodified production candidate when Workflow preparation fails", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-nitro-atomic-routes-"));
    tempRoots.push(appRoot);
    let nitro: Nitro | undefined;
    createNitroMock.mockImplementationOnce(async (config: NitroConfig) => {
      nitro = createNitroStub(config);
      return nitro;
    });
    workflowBuilderBuild.mockRejectedValueOnce(new Error("workflow preparation failed"));

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const createCandidate = createProductionApplicationNitro(createPreparedHost(appRoot), {
      buildDir: join(appRoot, ".eve", "nitro-all"),
      outputDir: join(appRoot, ".output"),
      surface: "all",
    });

    await expect(createCandidate).rejects.toThrow("workflow preparation failed");
    expect(nitro).toBeDefined();
    expect(nitro?.options.handlers).toEqual([]);
    expect(nitro?.options.virtual).toEqual({});
    expect(nitro?.options.alias).toEqual({});
    expect(nitro?.options.tasks).toEqual({});
    expect(nitro?.options.scheduledTasks).toEqual({});
    expect(nitro?.hooks.hook).not.toHaveBeenCalled();
    expect(nitro?.routing.sync).not.toHaveBeenCalled();
    expect(nitro?.close).toHaveBeenCalledOnce();
  });
});
