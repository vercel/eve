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
import {
  bundleFinalWorkflowOutput,
  collectWorkflowInputFiles,
  convertClassesManifest,
  convertStepsManifest,
  convertWorkflowsManifest,
  createEvePackageImportsPlugin,
  createWorkflowImport,
  createWorkflowNodeBuiltinGuardPlugin,
  createWorkflowPseudoPackagePlugin,
  createWorkflowTransformPlugin,
  createWorkflowVirtualEntryPlugin,
  WORKFLOW_VIRTUAL_ENTRY_ID,
  type WorkflowBundleBuilderConfig,
  type WorkflowBundleBuilderOptions,
  type WorkflowBundleCreateWorkflowsBundleOptions,
  type WorkflowBundleCreateWorkflowsBundleResult,
  type WorkflowBundleDiscoveredEntries,
} from "#internal/workflow-bundle/builder-support.js";
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import { writeNitroStepEntrypoint } from "#internal/workflow-bundle/nitro-step-entry.js";
import {
  WORKFLOW_BUILDER_DEFERRED_PACKAGES,
  WORKFLOW_STEP_EXTERNAL_PACKAGES,
} from "#internal/workflow-bundle/vercel-workflow-output.js";
import {
  detectWorkflowPatterns,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";

export class WorkflowBundleBuilder {
  readonly #compiledArtifactsBootstrapPath: string;
  readonly #outDir: string;
  readonly #queueNamespace: string;
  protected readonly config: WorkflowBundleBuilderConfig;
  readonly #discoveredEntries = new WeakMap<readonly string[], WorkflowBundleDiscoveredEntries>();

  constructor(options: WorkflowBundleBuilderOptions) {
    const dirs = [resolvePackageSourceDirectoryPath("src/execution")];
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

    const inputFiles = await this.#getBuildInputFiles();

    if (inputFiles.length === 0) {
      throw new Error(
        `Expected the execution workflow source file under "${resolvePackageSourceDirectoryPath("src/execution")}".`,
      );
    }

    const tsconfigPath = await this.findTsConfigPath();

    await mkdir(this.#outDir, { recursive: true });
    const discoveredEntries = await this.discoverEntries(inputFiles, this.#outDir, tsconfigPath);

    const stepsOutfile = join(this.#outDir, "steps.mjs");
    const workflowsOutfile = join(this.#outDir, "workflows.mjs");
    const nitroStepOutfile = options.nitroStepOutfile;
    const nitroWorkflowOutfile = options.nitroWorkflowOutfile;
    const stepsManifest = await writeNitroStepEntrypoint({
      builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
      discoveredEntries,
      outfile: stepsOutfile,
      preferAbsoluteFileImports: true,
      projectRoot: this.config.projectRoot ?? this.config.workingDir,
      sideEffectFiles: [this.#compiledArtifactsBootstrapPath],
      workingDir: this.config.workingDir,
    });
    if (nitroStepOutfile !== undefined && nitroStepOutfile !== stepsOutfile) {
      await writeNitroStepEntrypoint({
        builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
        discoveredEntries,
        outfile: nitroStepOutfile,
        preferAbsoluteFileImports: true,
        projectRoot: this.config.projectRoot ?? this.config.workingDir,
        sideEffectFiles: [this.#compiledArtifactsBootstrapPath],
        workingDir: this.config.workingDir,
      });
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
      discoveredEntries,
      outfile: workflowsOutfile,
      inputFiles,
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
    for (const filename of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = join(this.config.workingDir, filename);

      try {
        await readFile(candidate);
        return candidate;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    return undefined;
  }

  protected async getInputFiles(): Promise<string[]> {
    const roots = this.config.dirs.map((dir) => resolve(this.config.workingDir, dir));
    const files = await Promise.all(roots.map((root) => collectWorkflowInputFiles(root)));
    return files.flat();
  }

  protected async discoverEntries(
    inputs: readonly string[],
    _outdir: string,
    _tsconfigPath?: string,
  ): Promise<WorkflowBundleDiscoveredEntries> {
    const cached = this.#discoveredEntries.get(inputs);

    if (cached !== undefined) {
      return cached;
    }

    const discovered: WorkflowBundleDiscoveredEntries = {
      discoveredSerdeFiles: [],
      discoveredSteps: [],
      discoveredWorkflows: [],
    };

    for (const filePath of inputs) {
      const source = await readFile(filePath, "utf8");
      const patterns = detectWorkflowPatterns(source);

      if (patterns.hasUseStep) {
        discovered.discoveredSteps.push(filePath);
      }

      if (patterns.hasUseWorkflow) {
        discovered.discoveredWorkflows.push(filePath);
      }

      if (patterns.hasSerde) {
        discovered.discoveredSerdeFiles.push(filePath);
      }
    }

    this.#discoveredEntries.set(inputs, discovered);
    return discovered;
  }

  protected async createWorkflowsBundle({
    additionalOutputs = [],
    discoveredEntries,
    inputFiles,
    outfile,
    stepRegistrationsPath,
    tsconfigPath,
  }: WorkflowBundleCreateWorkflowsBundleOptions): Promise<WorkflowBundleCreateWorkflowsBundleResult> {
    const discovered =
      discoveredEntries ?? (await this.discoverEntries(inputFiles, dirname(outfile), tsconfigPath));
    const workflowFiles = [...discovered.discoveredWorkflows].sort();
    const workflowFileSet = new Set(workflowFiles);
    const serdeOnlyFiles = [...discovered.discoveredSerdeFiles]
      .sort()
      .filter((filePath) => !workflowFileSet.has(filePath));
    const workflowManifest: WorkflowManifest = {};
    const virtualEntrySource = [
      ...workflowFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
      ...serdeOnlyFiles.map((filePath) => createWorkflowImport(filePath, this.config.workingDir)),
    ].join("\n");
    const interimBundle = await buildSingleRolldownChunk(
      `intermediate workflow bundle for "${outfile}"`,
      {
        cwd: this.config.workingDir,
        input: WORKFLOW_VIRTUAL_ENTRY_ID,
        platform: "neutral",
        plugins: [
          createWorkflowVirtualEntryPlugin(virtualEntrySource),
          createWorkflowPseudoPackagePlugin(),
          createEvePackageImportsPlugin(this.config.workingDir, { workflowCondition: true }),
          createWorkflowTransformPlugin({
            manifest: workflowManifest,
            projectRoot: this.transformProjectRoot,
            sideEffectFiles: [...workflowFiles, ...serdeOnlyFiles],
            workingDir: this.config.workingDir,
          }),
          // Must run after the transform so `"use step"` bodies are already
          // stubbed and their node:* imports stripped from this graph.
          createWorkflowNodeBuiltinGuardPlugin(),
        ],
        resolve: {
          conditionNames: ["eve-source", "workflow"],
          extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
          mainFields: ["module", "main"],
        },
        tsconfig: tsconfigPath ?? false,
        output: {
          banner: "globalThis.__private_workflows = new Map();",
          comments: false,
          format: "cjs",
          sourcemap: "inline",
        },
      },
    );

    await Promise.all(
      [{ outfile, stepRegistrationsPath }, ...additionalOutputs].map((output) =>
        bundleFinalWorkflowOutput({
          code: interimBundle.code,
          outfile: output.outfile,
          queueNamespace: this.#queueNamespace,
          stepRegistrationsPath: output.stepRegistrationsPath,
        }),
      ),
    );

    return { manifest: workflowManifest };
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
