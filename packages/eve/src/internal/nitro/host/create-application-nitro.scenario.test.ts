import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Nitro } from "nitro/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import {
  type CompiledAgentManifest,
  type CompiledChannelDefinition,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import { createCompiledExternalDependencyPlan } from "#compiler/external-dependency-plan.js";
import {
  resolvePackageSourceDirectoryPath,
  resolvePackageRoot,
  resolveInstalledPackageInfo,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { resolveNitroBuildDirectory } from "#internal/application/paths.js";
import {
  createStubCompiledAgentManifest,
  createStubCompiledAgentNodeManifest as createCompiledAgentNodeManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import type {
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";
import { createEveVercelOptions } from "#internal/nitro/host/vercel-build-output-config.js";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#protocol/routes.js";

const configureDevelopmentNitroRoutes = vi.fn(async () => undefined);
const configureProductionNitroRoutes = vi.fn(async () => undefined);
const createNitroMock = vi.fn();
const registerScheduleTaskHandlers = vi.fn();
const externalDependencyFixtureRoots: string[] = [];

vi.mock("nitro/builder", () => ({
  createNitro: createNitroMock,
}));

vi.mock("./schedule-task-routes.js", () => ({
  registerScheduleTaskHandlers,
}));

vi.mock("./configure-nitro-routes.js", () => ({
  configureDevelopmentNitroRoutes,
  configureProductionNitroRoutes,
}));

vi.mock("#internal/workflow-bundle/workflow-builders.js", () => ({
  applyWorkflowTransform: vi.fn(async (_filename: string, _source: string) => ({
    code: "transformed-step-module",
    workflowManifest: {},
  })),
}));

interface NitroStub {
  readonly hookHandlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  readonly nitro: Nitro;
}

function createNitroStub(input: { buildDir?: string; dev?: boolean } = {}): NitroStub {
  const hookHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  return {
    hookHandlers,
    nitro: {
      hooks: {
        hook(name: string, handler: (...args: unknown[]) => unknown) {
          const handlers = hookHandlers.get(name) ?? [];
          handlers.push(handler);
          hookHandlers.set(name, handlers);
        },
      },
      options: {
        alias: {},
        buildDir: input.buildDir ?? "/tmp/.nitro",
        dev: input.dev ?? false,
        handlers: [],
        publicAssets: [],
        rootDir: "/tmp/weather-agent",
      },
      routing: {
        sync() {},
      },
    } as unknown as Nitro,
  };
}

function createPreparedHost(): PreparedDevelopmentApplicationHost {
  const appRoot = "/tmp/weather-agent";
  const paths = resolveCompilerArtifactPaths(appRoot);
  const metadata: CompileMetadata = {
    compile: {
      manifest: {
        path: paths.compiledManifestPath,
        sha256: "a".repeat(64),
      },
      moduleMap: {
        identitySha256: "f".repeat(64),
        path: paths.moduleMapPath,
        sha256: "b".repeat(64),
      },
    },
    discovery: {
      diagnostics: {
        path: paths.diagnosticsPath,
        sha256: "c".repeat(64),
      },
      manifest: {
        path: paths.discoveryManifestPath,
        sha256: "d".repeat(64),
      },
      sourceGraphHash: "e".repeat(64),
      summary: {
        errors: 0,
        warnings: 0,
      },
    },
    generator: {
      name: "test",
      version: "0.0.0",
    },
    kind: COMPILE_METADATA_KIND,
    status: "ready",
    version: COMPILE_METADATA_VERSION,
  };

  return {
    appRoot,
    compileResult: {
      diagnostics: [],
      manifest: createStubCompiledAgentManifest({
        agentRoot: `${appRoot}/agent`,
        appRoot,
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: "openai/gpt-5.4",
            routing: { kind: "gateway", target: "openai" },
          },
          name: "weather-agent",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      }),
      metadata,
      paths,
      project: {
        agentRoot: `${appRoot}/agent`,
        appRoot,
        layout: "nested",
      },
    } as unknown as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {
      bootstrapPath: `${appRoot}/.eve/bootstrap.mjs`,
      instrumentationPluginPath: `${appRoot}/.eve/instrumentation.mjs`,
      workflowWorldPluginPath: `${appRoot}/.eve/workflow-world.mjs`,
    } as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: [],
    schedules: [],
    generation: {
      fingerprint: "runtime-fingerprint",
      runtimeAppRoot: `${appRoot}/.eve/dev-runtime/snapshots/test/source/app`,
      snapshotRoot: `${appRoot}/.eve/dev-runtime/snapshots/test`,
      snapshotSourceRoot: `${appRoot}/.eve/dev-runtime/snapshots/test/source`,
      sourceRoot: appRoot,
    },
    workflowBuildDir: `${appRoot}/.eve/dev-hosts/test/workflow`,
    workspaceExtensions: [],
    workspace: {
      artifactsDir: `${appRoot}/.eve/dev-hosts/test/artifacts`,
      compilerArtifactsDir: `${appRoot}/.eve/dev-hosts/test/compiler`,
      nitroBuildDir: `${appRoot}/.eve/dev-hosts/test/nitro`,
      nitroOutputDir: `${appRoot}/.eve/dev-hosts/test/output`,
      rootDir: `${appRoot}/.eve/dev-hosts/test`,
      workflowBuildDir: `${appRoot}/.eve/dev-hosts/test/workflow`,
    },
  };
}

async function installTestExternalDependencyPlan(
  manifest: CompiledAgentManifest,
  entries: readonly {
    readonly application?: boolean;
    readonly extension?: boolean;
    readonly name: string;
  }[],
): Promise<void> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "eve-nitro-external-plan-"));
  externalDependencyFixtureRoots.push(fixtureRoot);
  for (const entry of entries) {
    const packageRoot = join(fixtureRoot, "node_modules", ...entry.name.split("/"));
    const entryRelativePath = entry.name === "sharp" ? "lib/index.js" : "index.js";
    await mkdir(join(packageRoot, ...entryRelativePath.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: {
          ".": `./${entryRelativePath}`,
          "./feature": {
            "eve-source": "./feature.source.ts",
            import: "./feature.import.js",
            default: "./feature.default.js",
          },
        },
        name: entry.name,
        type: "module",
      }),
    );
    await writeFile(join(packageRoot, entryRelativePath), "export default null;\n");
    await writeFile(join(packageRoot, "feature.source.ts"), "export default 'source';\n");
    await writeFile(join(packageRoot, "feature.import.js"), "export default 'import';\n");
    await writeFile(join(packageRoot, "feature.default.js"), "export default 'default';\n");
  }
  manifest.externalDependencyPlan = await createCompiledExternalDependencyPlan(
    entries.flatMap((entry) => [
      ...(entry.application === true
        ? [
            {
              packageName: entry.name,
              scope: {
                kind: "application" as const,
                nodeId: "__root__",
                sourceRoot: fixtureRoot,
              },
            },
          ]
        : []),
      ...(entry.extension === true
        ? [
            {
              packageName: entry.name,
              scope: {
                kind: "extension" as const,
                namespace: "layout",
                nodeId: "__root__",
                packageName: "layout-extension",
                sourceRoot: fixtureRoot,
              },
            },
          ]
        : []),
    ]),
  );
}

function createProductionOptions(preparedHost: PreparedApplicationHost) {
  return {
    buildDir: resolveNitroBuildDirectory(preparedHost.appRoot),
    outputDir: join(preparedHost.appRoot, ".output"),
  };
}

describe("application Nitro creation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env.VERCEL;
    await Promise.all(
      externalDependencyFixtureRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("installs the compiled instrumentation plan after artifacts and Workflow world", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    const instrumentationPluginPath = preparedHost.compiledArtifacts.instrumentationPluginPath;
    if (instrumentationPluginPath === undefined) {
      throw new Error("Expected instrumentation plugin fixture path.");
    }
    await createDevelopmentApplicationNitro(preparedHost);

    const plugins = createNitroMock.mock.calls[0]?.[0].plugins as string[];
    expect(plugins.indexOf(preparedHost.compiledArtifacts.bootstrapPath)).toBeLessThan(
      plugins.indexOf(preparedHost.compiledArtifacts.workflowWorldPluginPath),
    );
    expect(plugins.indexOf(preparedHost.compiledArtifacts.workflowWorldPluginPath)).toBeLessThan(
      plugins.indexOf(instrumentationPluginPath),
    );
    expect(plugins).not.toEqual(
      expect.arrayContaining([expect.stringContaining("local-tracing-runtime-plugin.ts")]),
    );
  });

  it("omits instrumentation from Nitro when no plugin was generated for the mode", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const fixtureHost = createPreparedHost();
    const preparedHost: PreparedDevelopmentApplicationHost = {
      ...fixtureHost,
      compiledArtifacts: {
        bootstrapPath: fixtureHost.compiledArtifacts.bootstrapPath,
        workflowWorldPluginPath: fixtureHost.compiledArtifacts.workflowWorldPluginPath,
      },
    };
    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const plugins = createNitroMock.mock.calls[0]?.[0].plugins as string[];
    expect(plugins).toEqual(
      expect.arrayContaining([
        preparedHost.compiledArtifacts.bootstrapPath,
        preparedHost.compiledArtifacts.workflowWorldPluginPath,
      ]),
    );
    expect(plugins).not.toEqual(
      expect.arrayContaining([expect.stringContaining("instrumentation")]),
    );
  });

  it("preserves workflow bundle side effects and skips workflow transform for cached bundles", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const rollupBeforeHooks = nitroStub.hookHandlers.get("rollup:before") ?? [];
    const originalTransform = vi.fn((code: string, id: string) => `${code}:${id}:transformed`);
    const workflowTransformPlugin: {
      name: string;
      transform: (code: string, id: string) => unknown;
    } = {
      name: "workflow:transform",
      transform: originalTransform,
    };
    const config = {
      plugins: [workflowTransformPlugin],
    };

    for (const hook of rollupBeforeHooks) {
      await hook(nitroStub.nitro, config);
    }

    const sideEffectsPlugin = (
      config.plugins as Array<{
        name?: string;
        resolveId?: (id: string, importer?: string) => unknown;
      }>
    ).find((plugin) => plugin.name === "eve:workflow-module-side-effects");
    if (sideEffectsPlugin === undefined) {
      throw new Error("Expected workflow side-effects plugin to be registered.");
    }

    const bundledStepPath = `${preparedHost.workflowBuildDir}/steps.mjs`;
    const cachedStepPath =
      "/Users/jj/dev/eve/packages/eve/.eve/workflow-cache/hash1234567890/steps.mjs";

    expect(sideEffectsPlugin.resolveId?.(bundledStepPath)).toEqual({
      id: bundledStepPath,
      moduleSideEffects: "no-treeshake",
    });
    expect(sideEffectsPlugin.resolveId?.(cachedStepPath)).toEqual({
      id: cachedStepPath,
      moduleSideEffects: "no-treeshake",
    });
    expect(
      sideEffectsPlugin.resolveId?.(
        "./workflows.mjs",
        "/tmp/.nitro/workflow/workflows-handler.mjs",
      ),
    ).toEqual({
      id: "/tmp/.nitro/workflow/workflows.mjs",
      moduleSideEffects: "no-treeshake",
    });
    expect(sideEffectsPlugin.resolveId?.("/tmp/other-module.mjs")).toBeNull();

    expect(workflowTransformPlugin.transform("code", bundledStepPath)).toBeNull();
    expect(workflowTransformPlugin.transform("code", cachedStepPath)).toBeNull();
    expect(workflowTransformPlugin.transform("code", "/tmp/other-module.mjs")).toBe(
      "code:/tmp/other-module.mjs:transformed",
    );
    expect(originalTransform).toHaveBeenCalledTimes(1);
  });

  it("externalizes prebuilt workflow bundles but keeps Nitro workflow entries bundled in dev mode", async () => {
    const nitroStub = createNitroStub({
      buildDir: "/tmp/weather-agent/.nitro",
      dev: true,
    });
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createDevelopmentApplicationNitro(preparedHost);

    const rollupBeforeHooks = nitroStub.hookHandlers.get("rollup:before") ?? [];
    const existingExternal = vi.fn((id: string) =>
      id === "/tmp/keep-external" ? false : undefined,
    );
    const config = {
      external: existingExternal,
      plugins: [],
    };

    for (const hook of rollupBeforeHooks) {
      await hook(nitroStub.nitro, config);
    }

    const external = config.external as (id: string) => boolean | null | undefined;
    expect(external(`${preparedHost.workflowBuildDir}/workflows.mjs`)).toBe(true);
    expect(external("/tmp/weather-agent/.nitro/workflow/workflows.mjs")).toBeUndefined();
    expect(external(`${preparedHost.workflowBuildDir}/steps.mjs`)).toBeUndefined();
    expect(external("/tmp/weather-agent/.nitro/workflow/steps.mjs")).toBeUndefined();
    expect(external("/tmp/keep-external")).toBe(false);
    expect(existingExternal).toHaveBeenCalledWith("/tmp/keep-external");
  });

  it("limits step-surface scan directories to the package execution directory", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createDevelopmentApplicationNitro(preparedHost);

    expect(createNitroMock).toHaveBeenCalledTimes(1);
    expect(createNitroMock.mock.calls[0]?.[0]).toMatchObject({
      rootDir: preparedHost.appRoot,
      scanDirs: [resolvePackageSourceDirectoryPath("src/execution")],
    });
  });

  it("keeps Nitro dev watch off authored app sources", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createDevelopmentApplicationNitro(preparedHost);

    expect(createNitroMock).toHaveBeenCalledTimes(1);
    expect(createNitroMock.mock.calls[0]?.[0]).toMatchObject({
      watchOptions: {
        ignored: [preparedHost.appRoot, join(preparedHost.appRoot, "**")],
      },
    });
  });

  it("sets the eve framework version and flow function rules on Vercel build output config", async () => {
    vi.stubEnv("VERCEL", "1");
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    expect(createNitroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "vercel",
        vercel: createEveVercelOptions({ agentName: "weather-agent", enabled: true }),
      }),
    );

    const vercelOptions = createNitroMock.mock.calls[0]?.[0].vercel;
    expect(vercelOptions?.config).toEqual({
      version: 3,
      framework: {
        slug: "eve",
        version: resolveInstalledPackageInfo().version,
      },
    });
    expect(vercelOptions?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH]).toMatchObject({
      maxDuration: "max",
      experimentalTriggers: [expect.objectContaining({ type: "queue/v2beta" })],
    });
  });

  it("enables websockets without overriding the Vercel entry format", async () => {
    vi.stubEnv("VERCEL", "1");
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    const websocketChannel: CompiledChannelDefinition = {
      kind: "channel",
      logicalPath: "channels/voice.ts",
      method: "WEBSOCKET",
      name: "voice",
      sourceId: "channels/voice.ts",
      sourceKind: "module",
      urlPath: "/eve/v1/voice/ws",
    };
    Object.assign(preparedHost.compileResult.manifest, {
      channelRoutes: { effective: [websocketChannel], preflight: [], shadowed: [] },
    });

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const nitroOptions = createNitroMock.mock.calls[0]?.[0];
    expect(nitroOptions).toMatchObject({
      features: {
        websocket: true,
      },
      preset: "vercel",
    });
    expect(nitroOptions?.vercel).toEqual(
      createEveVercelOptions({ agentName: "weather-agent", enabled: true }),
    );
  });

  it("clears Nitro build cache output from a different eve version", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "eve-nitro-version-cache-"));

    try {
      const nitroStub = createNitroStub();
      createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

      const preparedHost = createPreparedHost();
      preparedHost.appRoot = tempRoot;
      preparedHost.compileResult.project.appRoot = tempRoot;
      preparedHost.compileResult.project.agentRoot = join(tempRoot, "agent");
      const nitroBuildDir = resolveNitroBuildDirectory(tempRoot);
      const staleBuildOutputPath = join(nitroBuildDir, "stale-build-output.txt");

      await mkdir(nitroBuildDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(nitroBuildDir, "eve-cache.json"),
          `${JSON.stringify({ eveVersion: "0.0.0-old" })}\n`,
        ),
        writeFile(staleBuildOutputPath, "stale\n"),
      ]);

      const { createProductionApplicationNitro } =
        await import("#internal/nitro/host/create-application-nitro.js");
      await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

      await expect(readFile(staleBuildOutputPath, "utf8")).rejects.toThrow();
      await expect(readFile(join(nitroBuildDir, "eve-cache.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            eveVersion: resolveInstalledPackageInfo().version,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rewrites Windows paths in Nitro generated routing imports", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } = await import("./create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const rollupBeforeHooks = nitroStub.hookHandlers.get("rollup:before") ?? [];
    const config = {
      plugins: [],
    };

    for (const hook of rollupBeforeHooks) {
      await hook(nitroStub.nitro, config);
    }

    const routingImportPlugin = (
      config.plugins as Array<{
        name?: string;
        transform?: (code: string, id: string) => unknown;
      }>
    ).find((plugin) => plugin.name === "eve:nitro-routing-import-specifiers");
    if (routingImportPlugin?.transform === undefined) {
      throw new Error("Expected Nitro routing import specifier plugin to be registered.");
    }

    expect(
      routingImportPlugin.transform(
        'import handler from "G:\\projects\\test-eve\\dist\\route.js";',
        "#nitro/virtual/routing",
      ),
    ).toEqual({
      code: 'import handler from "file:///G:/projects/test-eve/dist/route.js";',
      map: null,
    });
    expect(
      routingImportPlugin.transform(
        'import meta from "G:\\projects\\test-eve\\dist\\route.js?meta";',
        "#nitro/virtual/routing-meta",
      ),
    ).toEqual({
      code: 'import meta from "file:///G:/projects/test-eve/dist/route.js?meta";',
      map: null,
    });
    expect(
      routingImportPlugin.transform(
        'import handler from "G:\\projects\\test-eve\\dist\\route.js";',
        "/tmp/other.js",
      ),
    ).toBeNull();
  });

  it("merges framework and configured hosted dependencies", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    preparedHost.compileResult.manifest.config = {
      ...preparedHost.compileResult.manifest.config,
      build: {
        externalDependencies: ["fixture-external", "sharp", "eve"],
      },
    } as typeof preparedHost.compileResult.manifest.config;
    await installTestExternalDependencyPlan(preparedHost.compileResult.manifest, [
      { application: true, name: "fixture-external" },
      { application: true, name: "sharp" },
      { application: true, name: "eve" },
    ]);

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const traceDeps = createNitroMock.mock.calls[0]?.[0].traceDeps;
    expect(traceDeps).toEqual(
      expect.arrayContaining(["@napi-rs/keyring", "sharp", "fixture-external"]),
    );
    expect(traceDeps.filter((dependencyName: string) => dependencyName === "sharp")).toHaveLength(
      1,
    );
    expect(traceDeps).not.toContain("eve");
  });

  it("fully traces dependencies requested by mounted extensions", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    preparedHost.compileResult.manifest.extensionMounts = [
      {
        externalDependencies: ["zod", "sharp"],
        mountLogicalPath: "extensions/layout.ts",
        mountSourceId: "extensions/layout.ts",
        namespace: "layout",
        packageName: "layout-extension",
        packageNamespace: "layout-extension",
        sourceRoot: process.cwd(),
      },
    ];
    preparedHost.compileResult.manifest.config = {
      ...preparedHost.compileResult.manifest.config,
      build: { externalDependencies: ["sharp"] },
    } as typeof preparedHost.compileResult.manifest.config;
    await installTestExternalDependencyPlan(preparedHost.compileResult.manifest, [
      { extension: true, name: "zod" },
      { application: true, extension: true, name: "sharp" },
    ]);

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const traceDeps = createNitroMock.mock.calls[0]?.[0].traceDeps;
    expect(traceDeps).toEqual(expect.arrayContaining(["zod*", "sharp", "sharp*"]));
    const plugins = createNitroMock.mock.calls[0]?.[0].rolldownConfig.plugins;
    const externalPlugin = plugins.find(
      (plugin: { name?: string }) => plugin.name === "eve-compiled-external-dependency",
    );
    // Nitro shallow-copies traceOpts before bundling and nf3 enumerates the
    // nested nft.paths object only in its post-build trace. Keep the exact
    // object Nitro retained here to assert that lifecycle, not just the
    // plugin's private map.
    const nftOptionsRetainedForTrace = {
      ...createNitroMock.mock.calls[0]?.[0].traceOpts.nft,
    };
    expect(nftOptionsRetainedForTrace.paths).toEqual({});
    expect(externalPlugin.resolveId("zod/feature")).toEqual({
      external: true,
      id: "zod/feature",
    });
    const pathsConsumedByPostBuildTrace = { ...nftOptionsRetainedForTrace.paths };
    expect(pathsConsumedByPostBuildTrace).toEqual({
      "zod/feature": expect.stringMatching(
        /external-dependencies[/\\]v2[/\\][a-f0-9]{64}[/\\]0[/\\]feature\.import\.js$/,
      ),
    });
  });

  it("traces configured hosted dependencies from subagent configs", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    const subagent: CompiledSubagentNode = {
      agent: createCompiledAgentNodeManifest(
        {
          kernelPlan: { prepared: [] },
          agentRoot: "/tmp/weather-agent/agent/subagents/investigator",
          appRoot: "/tmp/weather-agent",
          bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
          config: {
            build: {
              externalDependencies: ["subagent-external", "sharp"],
            },
            model: {
              id: "anthropic/claude-sonnet-5",
              routing: { kind: "gateway", target: "anthropic" },
            },
            name: "investigator",
            source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
          },
        },
        { isRoot: false, nodeId: "root:subagents/investigator" },
      ),
      backing: {
        externalDependencies: [],
        kind: "filesystem",
        sourcePath: "/tmp/weather-agent/agent/subagents/investigator",
      },
      description: "Investigates deployments.",
      entryPath: "subagents/investigator",
      logicalPath: "subagents/investigator",
      name: "investigator",
      nodeId: "root:subagents/investigator",
      owner: { kind: "application" },
      rootPath: "/tmp/weather-agent/agent/subagents/investigator",
      sourceId: "subagents/investigator",
      sourceKind: "subagent",
    };
    preparedHost.compileResult.manifest.subagents = [subagent];
    await installTestExternalDependencyPlan(preparedHost.compileResult.manifest, [
      { application: true, name: "subagent-external" },
      { application: true, name: "sharp" },
    ]);

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const traceDeps = createNitroMock.mock.calls[0]?.[0].traceDeps;
    expect(traceDeps).toEqual(expect.arrayContaining(["subagent-external", "sharp"]));
    expect(traceDeps.filter((dependencyName: string) => dependencyName === "sharp")).toHaveLength(
      1,
    );
  });

  it("leaves Nitro to classify unconfigured hosted dependencies", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    expect(createNitroMock.mock.calls[0]?.[0].traceDeps).toEqual(["@napi-rs/keyring"]);
  });

  it("includes the Workflow sandbox runtime plugin only when Workflow is enabled", async () => {
    const directNitroStub = createNitroStub();
    const workflowNitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(directNitroStub.nitro);
    createNitroMock.mockResolvedValueOnce(workflowNitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");

    const directHost = createPreparedHost();
    const workflowHost = createPreparedHost();
    workflowHost.compileResult.manifest.workflowTool = {
      logicalPath: "tools/workflow.ts",
      sourceId: "test:workflow",
      sourceKind: "module",
    };

    await createProductionApplicationNitro(directHost, createProductionOptions(directHost));
    await createProductionApplicationNitro(workflowHost, createProductionOptions(workflowHost));

    const directPlugins = createNitroMock.mock.calls[0]?.[0].plugins as string[];
    const workflowPlugins = createNitroMock.mock.calls[1]?.[0].plugins as string[];

    expect(directPlugins).not.toEqual(
      expect.arrayContaining([expect.stringContaining("workflow-sandbox-runtime-plugin.ts")]),
    );
    expect(workflowPlugins).toEqual(
      expect.arrayContaining([expect.stringContaining("workflow-sandbox-runtime-plugin.ts")]),
    );
  });

  it("includes the sandbox shutdown plugin only for production builds", async () => {
    const productionNitroStub = createNitroStub();
    const devNitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(productionNitroStub.nitro);
    createNitroMock.mockResolvedValueOnce(devNitroStub.nitro);

    const { createDevelopmentApplicationNitro, createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");

    const productionHost = createPreparedHost();
    await createProductionApplicationNitro(productionHost, createProductionOptions(productionHost));
    await createDevelopmentApplicationNitro(createPreparedHost());

    const productionPlugins = createNitroMock.mock.calls[0]?.[0].plugins as string[];
    const devPlugins = createNitroMock.mock.calls[1]?.[0].plugins as string[];

    expect(productionPlugins).toEqual(
      expect.arrayContaining([expect.stringContaining("sandbox-shutdown-plugin.ts")]),
    );
    expect(devPlugins).not.toEqual(
      expect.arrayContaining([expect.stringContaining("sandbox-shutdown-plugin.ts")]),
    );
  });

  it("deduplicates defaults when the app also lists them", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    preparedHost.compileResult.manifest.config = {
      ...preparedHost.compileResult.manifest.config,
      build: {
        externalDependencies: ["@napi-rs/keyring", "sharp", "fixture-external"],
      },
    } as typeof preparedHost.compileResult.manifest.config;
    await installTestExternalDependencyPlan(preparedHost.compileResult.manifest, [
      { application: true, name: "@napi-rs/keyring" },
      { application: true, name: "sharp" },
      { application: true, name: "fixture-external" },
    ]);

    await createProductionApplicationNitro(preparedHost, createProductionOptions(preparedHost));

    const traceDeps = createNitroMock.mock.calls[0]?.[0].traceDeps;
    expect(traceDeps).toEqual(
      expect.arrayContaining(["@napi-rs/keyring", "sharp", "fixture-external"]),
    );
    expect(
      traceDeps.filter((dependencyName: string) => dependencyName === "@napi-rs/keyring"),
    ).toHaveLength(1);
    expect(traceDeps.filter((dependencyName: string) => dependencyName === "sharp")).toHaveLength(
      1,
    );
  });

  it("transforms the modules imported by the Nitro step entry", async () => {
    const nitroBuildDir = await mkdtemp(join(tmpdir(), "eve-nitro-build-"));
    const nitroStub = createNitroStub({
      buildDir: nitroBuildDir,
    });
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);
    const workflowBuildDir = await mkdtemp(join(tmpdir(), "eve-step-transform-"));
    const importedModulesDir = join(workflowBuildDir, "imports");
    const stepModulePath = join(importedModulesDir, "step-module.js");
    const bootstrapModulePath = join(importedModulesDir, "bootstrap.mjs");
    const packageDistStepModulePath = join(
      resolvePackageRoot(),
      "dist",
      "src",
      "execution",
      "create-session-step.js",
    );

    await mkdir(importedModulesDir, { recursive: true });
    await Promise.all([
      writeFile(stepModulePath, 'export const step = "step";\n'),
      writeFile(bootstrapModulePath, 'export const bootstrap = "bootstrap";\n'),
      writeFile(
        join(workflowBuildDir, "steps.mjs"),
        [
          'import "workflow/internal/builtins";',
          'import "./imports/step-module.js";',
          'import "./imports/bootstrap.mjs";',
          `import ${JSON.stringify(packageDistStepModulePath)};`,
          "export const __steps_registered = true;",
          "",
        ].join("\n"),
      ),
    ]);

    try {
      const { createProductionApplicationNitro } =
        await import("#internal/nitro/host/create-application-nitro.js");
      const preparedHost = createPreparedHost();
      preparedHost.workflowBuildDir = workflowBuildDir;
      await createProductionApplicationNitro(preparedHost, {
        ...createProductionOptions(preparedHost),
        buildDir: nitroBuildDir,
      });

      const rollupBeforeHooks = nitroStub.hookHandlers.get("rollup:before") ?? [];
      const config = {
        plugins: [],
      };

      for (const hook of rollupBeforeHooks) {
        await hook(nitroStub.nitro, config);
      }

      const stepTransformPlugin = (
        config.plugins as Array<{
          name?: string;
          transform?: (code: string, id: string) => Promise<unknown>;
        }>
      ).find((plugin) => plugin.name === "eve:workflow-step-transform");
      if (stepTransformPlugin?.transform === undefined) {
        throw new Error("Expected Nitro step transform plugin to be registered.");
      }
      const stepModuleSideEffectsPlugin = (
        config.plugins as Array<{
          name?: string;
          resolveId?: (id: string, importer?: string) => Promise<unknown>;
        }>
      ).find((plugin) => plugin.name === "eve:workflow-step-module-side-effects");
      if (stepModuleSideEffectsPlugin?.resolveId === undefined) {
        throw new Error("Expected Nitro step side-effects plugin to be registered.");
      }

      expect(await stepTransformPlugin.transform("step source", stepModulePath)).toEqual({
        code: "transformed-step-module",
        map: null,
      });
      expect(await stepTransformPlugin.transform("bootstrap source", bootstrapModulePath)).toEqual({
        code: "transformed-step-module",
        map: null,
      });
      expect(
        await stepTransformPlugin.transform(
          "builtins source",
          resolveWorkflowModulePath("workflow/internal/builtins"),
        ),
      ).toEqual({
        code: "transformed-step-module",
        map: null,
      });
      expect(
        await stepTransformPlugin.transform("package dist source", packageDistStepModulePath),
      ).toEqual({
        code: "transformed-step-module",
        map: null,
      });
      await expect(
        stepModuleSideEffectsPlugin.resolveId(
          "./imports/step-module.js",
          join(workflowBuildDir, "steps.mjs"),
        ),
      ).resolves.toEqual({
        id: stepModulePath,
        moduleSideEffects: "no-treeshake",
      });
      await expect(
        stepModuleSideEffectsPlugin.resolveId(
          "./imports/bootstrap.mjs",
          join(workflowBuildDir, "steps.mjs"),
        ),
      ).resolves.toEqual({
        id: bootstrapModulePath,
        moduleSideEffects: "no-treeshake",
      });
      await expect(
        stepModuleSideEffectsPlugin.resolveId(
          "workflow/internal/builtins",
          join(workflowBuildDir, "steps.mjs"),
        ),
      ).resolves.toEqual({
        id: resolveWorkflowModulePath("workflow/internal/builtins"),
        moduleSideEffects: "no-treeshake",
      });
      await expect(
        stepModuleSideEffectsPlugin.resolveId(
          "/tmp/not-imported.js",
          join(workflowBuildDir, "steps.mjs"),
        ),
      ).resolves.toBeNull();
      expect(
        await stepTransformPlugin.transform("other source", "/tmp/not-imported.js"),
      ).toBeNull();
      expect(applyWorkflowTransform).toHaveBeenCalledTimes(4);
      expect(applyWorkflowTransform).toHaveBeenNthCalledWith(
        4,
        "src/execution/create-session-step.js",
        "package dist source",
        "step",
        packageDistStepModulePath,
        "/tmp/weather-agent",
      );
    } finally {
      await rm(workflowBuildDir, { force: true, recursive: true });
      await rm(nitroBuildDir, { force: true, recursive: true });
    }
  });
});
