import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  resolvePackageSourceDirectoryPath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import { runQueuedWorkflowBuild } from "#internal/workflow-bundle/build-queue.js";
import { createAuthoredPackageTsConfigPathsPlugin } from "#internal/authored-package-tsconfig-paths.js";
import { createAuthoredRelativeExtensionResolverPlugin } from "#internal/authored-relative-extension-resolver.js";
import {
  type AuthoredWorkflowModules,
  bundleFinalWorkflowOutput,
  collectWorkflowInputFiles,
  composeWorkflowDriverCode,
  convertClassesManifest,
  convertStepsManifest,
  convertWorkflowsManifest,
  createEvePackageImportsPlugin,
  createWorkflowImport,
  createWorkflowNodeBuiltinGuardPlugin,
  createWorkflowDriverAliasPlugin,
  createWorkflowPseudoPackagePlugin,
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
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import {
  type NitroStepEntrypointDiscoveredEntries,
  writeNitroStepEntrypoint,
} from "#internal/workflow-bundle/nitro-step-entry.js";
import {
  WORKFLOW_BUILDER_DEFERRED_PACKAGES,
  WORKFLOW_STEP_EXTERNAL_PACKAGES,
} from "#internal/workflow-bundle/vercel-workflow-output.js";
import {
  findWorkflowPatterns,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";

export class WorkflowBundleBuilder {
  readonly #authoredWorkflowModules: AuthoredWorkflowModules;
  readonly #compiledArtifactsBootstrapPath: string;
  readonly #outDir: string;
  readonly #queueNamespace: string;
  protected readonly config: WorkflowBundleBuilderConfig;

  constructor(options: WorkflowBundleBuilderOptions) {
    const dirs = [
      resolvePackageSourceDirectoryPath("src/execution"),
      resolvePackageSourceDirectoryPath("src/runtime/subagents"),
      resolvePackageSourceDirectoryPath("src/subagents"),
    ];
    if (options.includeTestFixtures === true) {
      dirs.push(resolvePackageSourceDirectoryPath("src/internal/testing"));
    }
    this.config = {
      buildTarget: "standalone",
      dirs,
      externalPackages: [...WORKFLOW_STEP_EXTERNAL_PACKAGES, ...WORKFLOW_BUILDER_DEFERRED_PACKAGES],
      // Keep package-version workflow ids stable across bundling targets.
      projectRoot: options.appRoot,
      watch: options.watch,
      workingDir: options.rootDir,
    };

    this.#authoredWorkflowModules = options.authoredWorkflowModules ?? {
      directiveModules: [],
      workflowModules: [],
    };
    this.#compiledArtifactsBootstrapPath = options.compiledArtifactsBootstrapPath;
    this.#outDir = options.outDir;
    this.#queueNamespace = deriveEveWorkflowQueueNamespace(options.agentName);
  }

  async build(
    options: { nitroStepOutfile?: string; nitroWorkflowOutfile?: string } = {},
  ): Promise<void> {
    await runQueuedWorkflowBuild(this.#outDir, async () => this.#performBuild(options));
  }

  async #performBuild(options: {
    nitroStepOutfile?: string;
    nitroWorkflowOutfile?: string;
  }): Promise<void> {
    await prepareEveVersionedCacheDirectory(this.#outDir);

    const frameworkInputFiles = await this.#getBuildInputFiles();

    if (frameworkInputFiles.length === 0) {
      throw new Error(
        `Expected framework workflow source files under eve's execution, runtime/subagents, or subagents source directories.`,
      );
    }

    const tsconfigPath = await this.findTsConfigPath();

    await mkdir(this.#outDir, { recursive: true });
    const frameworkEntries = await this.discoverEntries(frameworkInputFiles);
    const appEntries = this.#authoredWorkflowModules;
    const stepEntries = mergeStepEntries(frameworkEntries, appEntries);

    const stepsOutfile = join(this.#outDir, "steps.mjs");
    const workflowsOutfile = join(this.#outDir, "workflows.mjs");
    const nitroStepOutfile = options.nitroStepOutfile;
    const nitroWorkflowOutfile = options.nitroWorkflowOutfile;
    const writeStepEntry = (outfile: string) =>
      writeNitroStepEntrypoint({
        builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
        discoveredEntries: stepEntries,
        outfile,
        preferAbsoluteFileImports: true,
        projectRoot: this.config.projectRoot ?? this.config.workingDir,
        sideEffectFiles: [this.#compiledArtifactsBootstrapPath],
        workingDir: this.config.workingDir,
      });
    const stepsManifest = await writeStepEntry(stepsOutfile);
    if (nitroStepOutfile !== undefined && nitroStepOutfile !== stepsOutfile) {
      await writeStepEntry(nitroStepOutfile);
    }
    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      additionalOutputs:
        nitroWorkflowOutfile === undefined || nitroWorkflowOutfile === workflowsOutfile
          ? []
          : [
              {
                outfile: nitroWorkflowOutfile,
                stepRegistrationsPath: nitroStepOutfile ?? stepsOutfile,
              },
            ],
      appWorkflowFiles: appEntries.workflowModules,
      frameworkSerdeFiles: frameworkEntries.discoveredSerdeFiles,
      frameworkWorkflowFiles: frameworkEntries.discoveredWorkflows,
      outfile: workflowsOutfile,
      stepRegistrationsPath: stepsOutfile,
      tsconfigPath,
    });

    await this.createManifest({
      workflowBundlePath: join(this.#outDir, "workflows.mjs"),
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
    await writeEveVersionedCacheMetadata(this.#outDir);
  }

  protected get transformProjectRoot(): string {
    return this.config.projectRoot ?? this.config.workingDir;
  }

  protected async findTsConfigPath(): Promise<string | undefined> {
    let current = this.transformProjectRoot;

    while (true) {
      for (const filename of ["tsconfig.json", "jsconfig.json"]) {
        const candidate = join(current, filename);

        try {
          await readFile(candidate);
          return candidate;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }

      const parent = dirname(current);

      if (parent === current) {
        return undefined;
      }

      current = parent;
    }
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

    for (const filePath of inputs) {
      const source = await readFile(filePath, "utf8");
      const patterns = await findWorkflowPatterns(filePath, source);

      if (patterns.hasUseStep) discovered.discoveredSteps.push(filePath);
      if (patterns.hasUseWorkflow) discovered.discoveredWorkflows.push(filePath);
      if (patterns.hasSerde) discovered.discoveredSerdeFiles.push(filePath);
    }

    return discovered;
  }

  protected async createWorkflowsBundle({
    additionalOutputs = [],
    appWorkflowFiles,
    frameworkSerdeFiles,
    frameworkWorkflowFiles,
    outfile,
    stepRegistrationsPath,
    tsconfigPath,
  }: WorkflowBundleCreateWorkflowsBundleOptions): Promise<WorkflowBundleCreateWorkflowsBundleResult> {
    const manifest: WorkflowManifest = {};
    const frameworkChunk = await this.#buildDriverChunk({
      label: "framework",
      manifest,
      serdeFiles: frameworkSerdeFiles,
      tsconfigPath,
      workflowFiles: frameworkWorkflowFiles,
    });
    const appChunk = await this.#buildDriverChunk({
      label: "app",
      manifest,
      serdeFiles: [],
      tsconfigPath,
      workflowFiles: appWorkflowFiles,
    });
    const workflowCode = composeWorkflowDriverCode([frameworkChunk, appChunk]);

    await Promise.all(
      [{ outfile, stepRegistrationsPath }, ...additionalOutputs].map((output) =>
        bundleFinalWorkflowOutput({
          code: workflowCode,
          outfile: output.outfile,
          queueNamespace: this.#queueNamespace,
          stepRegistrationsPath: output.stepRegistrationsPath,
        }),
      ),
    );

    return { manifest };
  }

  /**
   * One driver layer, without registry banner or entrypoint wrapper so
   * `composeWorkflowDriverCode` can concatenate layers. `""` when the layer has
   * nothing to bundle, the common case for an app with no workflow tools.
   */
  async #buildDriverChunk(options: {
    label: string;
    manifest: WorkflowManifest;
    serdeFiles: readonly string[];
    tsconfigPath?: string;
    workflowFiles: readonly string[];
  }): Promise<string> {
    const workflowFiles = [...options.workflowFiles].sort();
    const workflowFileSet = new Set(workflowFiles);
    const serdeOnlyFiles = [...options.serdeFiles]
      .sort()
      .filter((filePath) => !workflowFileSet.has(filePath));
    if (workflowFiles.length === 0 && serdeOnlyFiles.length === 0) return "";

    const virtualEntrySource = [
      ...workflowFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
      ...serdeOnlyFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
    ].join("\n");
    const interimBundle = await buildSingleRolldownChunk(`${options.label} workflow driver chunk`, {
      cwd: this.config.workingDir,
      onwarn(warning: { code: string; message: string }, warn: (warning: unknown) => void) {
        if (warning.code === "UNRESOLVED_IMPORT") {
          throw new Error(`Cannot build workflow bundle: ${warning.message}`);
        }
        warn(warning);
      },
      input: WORKFLOW_VIRTUAL_ENTRY_ID,
      platform: "neutral",
      plugins: [
        createWorkflowVirtualEntryPlugin(virtualEntrySource),
        createWorkflowPseudoPackagePlugin(),
        createWorkflowDriverAliasPlugin(this.config.workingDir),
        createAuthoredRelativeExtensionResolverPlugin({
          extensions: WORKFLOW_SOURCE_EXTENSIONS,
        }),
        createAuthoredPackageTsConfigPathsPlugin({
          appPackageRoot: this.transformProjectRoot,
          extensions: WORKFLOW_SOURCE_EXTENSIONS,
        }),
        createEvePackageImportsPlugin(this.config.workingDir, { workflowCondition: true }),
        createWorkflowTransformPlugin({
          manifest: options.manifest,
          projectRoot: this.transformProjectRoot,
          sideEffectFiles: [...workflowFiles, ...serdeOnlyFiles],
          workingDir: this.config.workingDir,
        }),
        // After the transform, so stubbed step bodies' node:* imports are already gone.
        createWorkflowNodeBuiltinGuardPlugin(),
      ],
      resolve: {
        conditionNames: ["eve-source", "workflow"],
        extensions: WORKFLOW_SOURCE_EXTENSIONS,
        mainFields: ["module", "main"],
      },
      tsconfig: options.tsconfigPath ?? false,
      output: {
        comments: false,
        format: "cjs",
        sourcemap: "inline",
      },
    });
    return interimBundle.code;
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
