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
  createCompiledAgentNodeManifest,
  type CompiledChannelEntry,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  resolvePackageSourceDirectoryPath,
  resolvePackageRoot,
  resolveInstalledPackageInfo,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { resolveNitroBuildDirectory } from "#internal/application/paths.js";
import type {
  NitroBuildSurface,
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";
import { applyWorkflowTransform } from "#internal/workflow-bundle/workflow-builders.js";

const configureDevelopmentNitroRoutes = vi.fn(async () => undefined);
const configureProductionNitroRoutes = vi.fn(async () => undefined);
const createNitroMock = vi.fn();
const registerScheduleTaskHandlers = vi.fn();

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
      moduleMap: {
        path: paths.moduleMapPath,
        sha256: "module-map-sha",
      },
    },
    discovery: {
      diagnostics: {
        path: paths.diagnosticsPath,
        sha256: "diagnostics-sha",
      },
      manifest: {
        path: paths.discoveryManifestPath,
        sha256: "manifest-sha",
      },
      sourceGraphHash: "source-graph-sha",
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
      manifest: {
        channels: [],
        config: {},
        sandbox: null,
        subagents: [],
      },
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

function createProductionOptions(
  preparedHost: PreparedApplicationHost,
  surface: NitroBuildSurface,
) {
  return {
    buildDir: resolveNitroBuildDirectory(preparedHost.appRoot, surface),
    outputDir: join(preparedHost.appRoot, ".output"),
    surface,
  };
}

describe("application Nitro creation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.VERCEL;
  });

  it("installs compiled artifacts before constructing the Workflow world", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createDevelopmentApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createDevelopmentApplicationNitro(preparedHost);

    const plugins = createNitroMock.mock.calls[0]?.[0].plugins as string[];

    expect(plugins.indexOf(preparedHost.compiledArtifacts.bootstrapPath)).toBeLessThan(
      plugins.indexOf(preparedHost.compiledArtifacts.workflowWorldPluginPath),
    );
  });

  it("preserves workflow bundle side effects and skips workflow transform for cached bundles", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );

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

  it("sets the eve framework version on Vercel app-surface build output config", async () => {
    vi.stubEnv("VERCEL", "1");
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "app"),
    );

    expect(createNitroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "vercel",
        vercel: {
          config: {
            version: 3,
            framework: {
              slug: "eve",
              version: resolveInstalledPackageInfo().version,
            },
          },
        },
      }),
    );
  });

  it("enables websockets without overriding the Vercel entry format", async () => {
    vi.stubEnv("VERCEL", "1");
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    const websocketChannel: CompiledChannelEntry = {
      kind: "channel",
      logicalPath: "channels/voice.ts",
      method: "WEBSOCKET",
      name: "voice",
      sourceId: "channels/voice.ts",
      sourceKind: "module",
      urlPath: "/eve/v1/voice/ws",
    };
    preparedHost.compileResult.manifest.channels = [websocketChannel];

    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "app"),
    );

    const nitroOptions = createNitroMock.mock.calls[0]?.[0];
    expect(nitroOptions).toMatchObject({
      features: {
        websocket: true,
      },
      preset: "vercel",
    });
    expect(nitroOptions?.vercel).toEqual({
      config: {
        version: 3,
        framework: {
          slug: "eve",
          version: resolveInstalledPackageInfo().version,
        },
      },
    });
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
      await createProductionApplicationNitro(
        preparedHost,
        createProductionOptions(preparedHost, "all"),
      );

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
    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );

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
    const allNitroStub = createNitroStub();
    const appNitroStub = createNitroStub();
    const flowNitroStub = createNitroStub();
    createNitroMock
      .mockResolvedValueOnce(allNitroStub.nitro)
      .mockResolvedValueOnce(appNitroStub.nitro)
      .mockResolvedValueOnce(flowNitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    preparedHost.compileResult.manifest.config = {
      ...preparedHost.compileResult.manifest.config,
      build: {
        externalDependencies: ["fixture-external", "sharp", "eve"],
      },
    } as typeof preparedHost.compileResult.manifest.config;

    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );
    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "app"),
    );
    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "flow"),
    );

    for (const call of createNitroMock.mock.calls.slice(0, 3)) {
      const traceDeps = call[0].traceDeps;
      expect(traceDeps).toEqual(
        expect.arrayContaining(["@napi-rs/keyring", "sharp", "fixture-external"]),
      );
      expect(traceDeps.filter((dependencyName: string) => dependencyName === "sharp")).toHaveLength(
        1,
      );
      expect(traceDeps).not.toContain("eve");
    }
  });

  it("traces configured hosted dependencies from subagent configs", async () => {
    const nitroStub = createNitroStub();
    createNitroMock.mockResolvedValueOnce(nitroStub.nitro);

    const { createProductionApplicationNitro } =
      await import("#internal/nitro/host/create-application-nitro.js");
    const preparedHost = createPreparedHost();
    const subagent: CompiledSubagentNode = {
      agent: createCompiledAgentNodeManifest({
        agentRoot: "/tmp/weather-agent/agent/subagents/investigator",
        appRoot: "/tmp/weather-agent",
        config: {
          build: {
            externalDependencies: ["subagent-external", "sharp"],
          },
          model: {
            id: "anthropic/claude-sonnet-5",
            routing: { kind: "gateway", target: "anthropic" },
          },
          name: "investigator",
        },
      }),
      description: "Investigates deployments.",
      entryPath: "subagents/investigator",
      logicalPath: "subagents/investigator/agent.ts",
      name: "investigator",
      nodeId: "root:subagents/investigator",
      rootPath: "/tmp/weather-agent/agent/subagents/investigator",
      sourceId: "subagents/investigator/agent.ts",
      sourceKind: "module",
    };
    preparedHost.compileResult.manifest.subagents = [subagent];

    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );

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

    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );

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
    workflowHost.compileResult.manifest.workflowTool = {};

    await createProductionApplicationNitro(directHost, createProductionOptions(directHost, "all"));
    await createProductionApplicationNitro(
      workflowHost,
      createProductionOptions(workflowHost, "all"),
    );

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
    await createProductionApplicationNitro(
      productionHost,
      createProductionOptions(productionHost, "all"),
    );
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

    await createProductionApplicationNitro(
      preparedHost,
      createProductionOptions(preparedHost, "all"),
    );

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
        ...createProductionOptions(preparedHost, "all"),
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
