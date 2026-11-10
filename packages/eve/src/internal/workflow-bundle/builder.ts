import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Plugin } from "rolldown";
import { mapConcurrent } from "#shared/map-concurrent.js";

import {
  resolvePackageSourceDirectoryPath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { findAuthoredPackageRoot } from "#internal/authored-package-boundary.js";
import {
  createAuthoredPlugins,
  resolveAuthoredTsConfigPath,
} from "#internal/bundler/authored-plugins.js";
import {
  type AuthoredWorkflowModules,
  bundleFinalWorkflowOutput,
  collectWorkflowInputFiles,
  composeWorkflowDriverCode,
  mergeWorkflowManifest,
  convertClassesManifest,
  convertStepsManifest,
  convertWorkflowsManifest,
  createEvePackageImportsPlugin,
  createWorkflowImport,
  createWorkflowNodeBuiltinGuardPlugin,
  createWorkflowDriverAliasPlugin,
  createWorkflowTransformPlugin,
  createWorkflowVirtualEntryPlugin,
  WORKFLOW_SOURCE_EXTENSIONS,
  WORKFLOW_VIRTUAL_ENTRY_ID,
  type WorkflowBundleBuilderConfig,
  type WorkflowBundleBuilderOptions,
  type WorkflowBundleCreateWorkflowsBundleOptions,
  type WorkflowBundleCreateWorkflowsBundleResult,
  type WorkflowBundleDiscoveredEntries,
} from "#internal/workflow-bundle/builder-support.js";
import { buildSingleRolldownChunk } from "#internal/bundler/rolldown.js";
import { onVendoredDependencyLog } from "#internal/bundler/vendored-dependency-log.js";
import {
  type DriverChunk,
  resolveInstalledEveRoot,
  reuseFrameworkDriverChunk,
} from "#internal/workflow-bundle/framework-driver-cache.js";
import {
  type NitroStepEntrypointDiscoveredEntries,
  writeNitroStepEntrypoint,
} from "#internal/workflow-bundle/nitro-step-entry.js";
import {
  findWorkflowPatterns,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";

/** The workflow directory one build wrote, as the host build consumes it. */
export interface WorkflowArtifacts {
  /** Absolute paths of the modules the step entry imports; the host bundles them in step mode. */
  readonly stepTargets: readonly string[];
  readonly stepsPath: string;
  readonly workflowsPath: string;
}

export class WorkflowBundleBuilder {
  readonly #authoredWorkflowModules: AuthoredWorkflowModules;
  readonly #compiledArtifactsBootstrapPath: string;
  readonly #outDir: string;
  readonly #queueNamespace: string;
  readonly #inlineSourcemap: boolean;
  protected readonly config: WorkflowBundleBuilderConfig;

  constructor(options: WorkflowBundleBuilderOptions) {
    const dirs = [
      resolvePackageSourceDirectoryPath("src/execution"),
      resolvePackageSourceDirectoryPath("src/runtime/subagents"),
      resolvePackageSourceDirectoryPath("src/runtime/connections/events"),
      resolvePackageSourceDirectoryPath("src/subagents"),
      resolvePackageSourceDirectoryPath("src/tools/provided"),
    ];
    if (options.includeTestFixtures === true) {
      dirs.push(resolvePackageSourceDirectoryPath("src/internal/testing"));
    }
    this.config = {
      dirs,
      // Keep package-version workflow ids stable across bundling targets.
      projectRoot: options.appRoot,
      workingDir: options.rootDir,
    };

    this.#authoredWorkflowModules = options.authoredWorkflowModules ?? {
      directiveModules: [],
      workflowModules: [],
    };
    this.#compiledArtifactsBootstrapPath = options.compiledArtifactsBootstrapPath;
    this.#outDir = options.outDir;
    this.#queueNamespace = deriveEveWorkflowQueueNamespace(options.agentName);
    this.#inlineSourcemap = options.inlineSourcemap ?? true;
  }

  async build(): Promise<WorkflowArtifacts> {
    const frameworkInputFiles = await this.#getBuildInputFiles();

    if (frameworkInputFiles.length === 0) {
      throw new Error(
        `Expected framework workflow source files under eve's execution, runtime/subagents, subagents, or tools/provided source directories.`,
      );
    }

    await mkdir(this.#outDir, { recursive: true });
    const frameworkEntries = await this.discoverEntries(frameworkInputFiles);
    const appEntries = this.#authoredWorkflowModules;
    const stepsPath = join(this.#outDir, "steps.mjs");
    const workflowsPath = join(this.#outDir, "workflows.mjs");
    const { manifest: stepsManifest, stepTargets } = await writeNitroStepEntrypoint({
      builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
      discoveredEntries: mergeStepEntries(frameworkEntries, appEntries),
      outfile: stepsPath,
      projectRoot: this.transformProjectRoot,
      sideEffectFiles: [this.#compiledArtifactsBootstrapPath],
      workingDir: this.config.workingDir,
    });
    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      appWorkflowFiles: appEntries.workflowModules,
      frameworkSerdeFiles: frameworkEntries.discoveredSerdeFiles,
      frameworkWorkflowFiles: frameworkEntries.discoveredWorkflows,
      outfile: workflowsPath,
      stepRegistrationsPath: stepsPath,
    });

    await this.createManifest({
      workflowBundlePath: workflowsPath,
      manifestDir: this.#outDir,
      manifest: {
        steps: {
          ...stepsManifest.steps,
          ...workflowsManifest.steps,
        },
        workflows: {
          ...stepsManifest.workflows,
          ...workflowsManifest.workflows,
        },
        classes: {
          ...stepsManifest.classes,
          ...workflowsManifest.classes,
        },
      },
    });

    return { stepTargets, stepsPath, workflowsPath };
  }

  protected get transformProjectRoot(): string {
    return this.config.projectRoot ?? this.config.workingDir;
  }

  /** The authored package; a workspace member without its own package.json shares the enclosing one. */
  protected get authoredPackageRoot(): string {
    return findAuthoredPackageRoot(this.transformProjectRoot) ?? this.transformProjectRoot;
  }

  protected async getInputFiles(): Promise<string[]> {
    const roots = this.config.dirs.map((dir) => resolve(this.config.workingDir, dir));
    const files = await Promise.all(roots.map((root) => collectWorkflowInputFiles(root)));
    return files.flat();
  }

  protected async discoverEntries(
    inputs: readonly string[],
  ): Promise<WorkflowBundleDiscoveredEntries> {
    const discovered: WorkflowBundleDiscoveredEntries = {
      discoveredSerdeFiles: [],
      discoveredSteps: [],
      discoveredWorkflows: [],
    };

    const entries = await mapConcurrent(inputs, async (filePath) => {
      const source = await readFile(filePath, "utf8");
      const patterns = await findWorkflowPatterns(filePath, source);
      return { filePath, patterns };
    });

    for (const { filePath, patterns } of entries) {
      if (patterns.hasUseStep) discovered.discoveredSteps.push(filePath);
      if (patterns.hasUseWorkflow) discovered.discoveredWorkflows.push(filePath);
      if (patterns.hasSerde) discovered.discoveredSerdeFiles.push(filePath);
    }

    return discovered;
  }

  protected async createWorkflowsBundle({
    appWorkflowFiles,
    frameworkSerdeFiles,
    frameworkWorkflowFiles,
    outfile,
    stepRegistrationsPath,
  }: WorkflowBundleCreateWorkflowsBundleOptions): Promise<WorkflowBundleCreateWorkflowsBundleResult> {
    const manifest: WorkflowManifest = {};
    const installedEveRoot = resolveInstalledEveRoot();
    const chunks = await mapConcurrent(
      [
        {
          label: "framework",
          serdeFiles: frameworkSerdeFiles,
          workflowFiles: frameworkWorkflowFiles,
        },
        { label: "app", serdeFiles: [], workflowFiles: appWorkflowFiles },
      ],
      async (layer) =>
        layer.label === "framework" && installedEveRoot !== undefined
          ? await reuseFrameworkDriverChunk(
              {
                eveRoot: installedEveRoot,
                inlineSourcemap: this.#inlineSourcemap,
                inputFiles: [...layer.workflowFiles, ...layer.serdeFiles],
                packageRoot: this.authoredPackageRoot,
                projectRoot: this.transformProjectRoot,
                workingDir: this.config.workingDir,
              },
              async (graphPlugin) =>
                await this.#buildDriverChunk({ ...layer, authoredTsConfig: false, graphPlugin }),
            )
          : await this.#buildDriverChunk({ ...layer, authoredTsConfig: true }),
    );
    for (const chunk of chunks) mergeWorkflowManifest(manifest, chunk.manifest);
    const workflowCode = composeWorkflowDriverCode(chunks.map((chunk) => chunk.code));

    await bundleFinalWorkflowOutput({
      code: workflowCode,
      outfile,
      queueNamespace: this.#queueNamespace,
      stepRegistrationsPath,
    });

    return { manifest };
  }

  /**
   * One driver layer, without registry banner or entrypoint wrapper so
   * `composeWorkflowDriverCode` can concatenate layers. `""` when the layer has
   * nothing to bundle, the common case for an app with no workflow tools.
   */
  async #buildDriverChunk(options: {
    /** An installed eve ships compiled JavaScript, which the app's tsconfig must not reshape. */
    authoredTsConfig: boolean;
    /** Lets {@link reuseFrameworkDriverChunk} record the layer's build graph. */
    graphPlugin?: Plugin;
    label: string;
    serdeFiles: readonly string[];
    workflowFiles: readonly string[];
  }): Promise<DriverChunk> {
    const manifest: WorkflowManifest = {};
    const workflowFiles = [...options.workflowFiles].sort();
    const workflowFileSet = new Set(workflowFiles);
    const serdeOnlyFiles = [...options.serdeFiles]
      .sort()
      .filter((filePath) => !workflowFileSet.has(filePath));
    if (workflowFiles.length === 0 && serdeOnlyFiles.length === 0) return { code: "", manifest };

    const virtualEntrySource = [
      ...workflowFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
      ...serdeOnlyFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
    ].join("\n");
    const interimBundle = await buildSingleRolldownChunk(`${options.label} workflow driver chunk`, {
      cwd: this.config.workingDir,
      // Checked before the dependency-warning filter, which would otherwise
      // drop an unresolved import raised inside node_modules.
      onLog(level, log, defaultHandler) {
        if (level === "warn" && log.code === "UNRESOLVED_IMPORT") {
          throw new Error(`Cannot build workflow bundle: ${log.message}`);
        }
        onVendoredDependencyLog(level, log, defaultHandler);
      },
      input: WORKFLOW_VIRTUAL_ENTRY_ID,
      platform: "neutral",
      plugins: [
        createWorkflowVirtualEntryPlugin(virtualEntrySource),
        createWorkflowDriverAliasPlugin(this.config.workingDir),
        ...createAuthoredPlugins({
          authoredSourceOnly: true,
          extensions: WORKFLOW_SOURCE_EXTENSIONS,
          packageRoot: this.authoredPackageRoot,
        }),
        createEvePackageImportsPlugin(this.config.workingDir, { workflowCondition: true }),
        createWorkflowTransformPlugin({
          manifest,
          projectRoot: this.transformProjectRoot,
          sideEffectFiles: [...workflowFiles, ...serdeOnlyFiles],
          workingDir: this.config.workingDir,
        }),
        // After the transform, so stubbed step bodies' node:* imports are already gone.
        createWorkflowNodeBuiltinGuardPlugin(),
        options.graphPlugin,
      ],
      resolve: {
        conditionNames: ["eve-source", "workflow"],
        extensions: [...WORKFLOW_SOURCE_EXTENSIONS],
        mainFields: ["module", "main"],
      },
      tsconfig: options.authoredTsConfig
        ? resolveAuthoredTsConfigPath(this.authoredPackageRoot)
        : false,
      output: {
        comments: false,
        format: "cjs",
        sourcemap: this.#inlineSourcemap ? "inline" : false,
      },
    });
    return { code: interimBundle.code, manifest };
  }

  protected async createManifest({
    manifest,
    manifestDir,
  }: {
    manifest: WorkflowManifest;
    manifestDir: string;
    workflowBundlePath: string;
  }): Promise<string | undefined> {
    const output = {
      version: "1.0.0",
      steps: convertStepsManifest(manifest.steps),
      workflows: convertWorkflowsManifest(manifest.workflows),
      classes: convertClassesManifest(manifest.classes),
    };
    const manifestJson = JSON.stringify(output, null, 2);

    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "manifest.json"), manifestJson);
    return manifestJson;
  }

  async #getBuildInputFiles(): Promise<string[]> {
    return await this.getInputFiles();
  }
}

/** App step modules register with the framework's server steps; driver inputs stay per-layer. */
function mergeStepEntries(
  framework: WorkflowBundleDiscoveredEntries,
  app: AuthoredWorkflowModules,
): NitroStepEntrypointDiscoveredEntries {
  return {
    discoveredSerdeFiles: framework.discoveredSerdeFiles,
    discoveredSteps: [...new Set([...framework.discoveredSteps, ...app.directiveModules])],
  };
}
