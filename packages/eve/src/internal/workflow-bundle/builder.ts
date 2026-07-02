import { Buffer } from "node:buffer";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  resolvePackageSourceDirectoryPath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import {
  prepareEveVersionedCacheDirectory,
  writeEveVersionedCacheMetadata,
} from "#internal/application/cache-metadata.js";
import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  atomicWriteFile,
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
import {
  buildWithNitroRolldown,
  getSingleRolldownChunk,
} from "#internal/bundler/nitro-rolldown.js";
import { writeNitroStepEntrypoint } from "#internal/workflow-bundle/nitro-step-entry.js";
import {
  copyNitroFunctionDirectory,
  createWorkflowFunctionEnvironment,
  retargetNitroFunctionDirectoryToWorkflowRoute,
  WORKFLOW_BUILDER_DEFERRED_PACKAGES,
  WORKFLOW_STEP_EXTERNAL_PACKAGES,
} from "#internal/workflow-bundle/vercel-workflow-output.js";
import {
  detectWorkflowPatterns,
  createEveWorkflowQueueTrigger,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";
import { deriveEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";

// Serialize same-output builds so parallel Vercel surfaces never read
// `workflows.mjs` between the workflow wrapper write and literal rewrite pass.
const workflowBundleBuildLocks = new Map<string, Promise<void>>();

export class WorkflowBundleBuilder {
  readonly #agentName: string;
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

    this.#agentName = options.agentName;
    this.#compiledArtifactsBootstrapPath = options.compiledArtifactsBootstrapPath;
    this.#outDir = options.outDir;
    this.#queueNamespace = deriveEveWorkflowQueueNamespace(options.agentName);
  }

  async build(
    options: { nitroStepOutfile?: string; nitroWorkflowOutfile?: string } = {},
  ): Promise<void> {
    const previous = workflowBundleBuildLocks.get(this.#outDir) ?? Promise.resolve();
    const next = previous.then(() => this.#performBuild(options));
    workflowBundleBuildLocks.set(
      this.#outDir,
      next.catch(() => {}),
    );
    await next;
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

    const workflowsOutfile = join(this.#outDir, "workflows.mjs");
    const { manifest: workflowsManifest } = await this.createWorkflowsBundle({
      discoveredEntries,
      // eve owns dev rebuilds through `dev-authored-source-watcher`.
      keepInterimBundleContext: false,
      outfile: workflowsOutfile,
      bundleFinalOutput: false,
      format: "esm",
      inputFiles,
      tsconfigPath,
    });
    const stepsOutfile = join(this.#outDir, "steps.mjs");
    const stepsManifest = await writeNitroStepEntrypoint({
      builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
      discoveredEntries,
      outfile: stepsOutfile,
      preferAbsoluteFileImports: true,
      projectRoot: this.config.projectRoot ?? this.config.workingDir,
      workingDir: this.config.workingDir,
    });
    const nitroStepOutfile = options.nitroStepOutfile;

    if (nitroStepOutfile !== undefined && nitroStepOutfile !== stepsOutfile) {
      await writeNitroStepEntrypoint({
        builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
        discoveredEntries,
        outfile: nitroStepOutfile,
        preferAbsoluteFileImports: true,
        projectRoot: this.config.projectRoot ?? this.config.workingDir,
        workingDir: this.config.workingDir,
      });
    }

    await addStepRegistrationsImport(workflowsOutfile, stepsOutfile);
    await rewriteWorkflowRuntimeImports(workflowsOutfile);
    await rewriteWorkflowCodeLiteral(workflowsOutfile, this.#queueNamespace);

    const nitroWorkflowOutfile = options.nitroWorkflowOutfile;

    if (nitroWorkflowOutfile !== undefined && nitroWorkflowOutfile !== workflowsOutfile) {
      await mkdir(dirname(nitroWorkflowOutfile), { recursive: true });
      await mirrorFileBypassingUnlink(workflowsOutfile, nitroWorkflowOutfile);
      if (nitroStepOutfile !== undefined) {
        await addStepRegistrationsImport(nitroWorkflowOutfile, nitroStepOutfile);
        await rewriteWorkflowRuntimeImports(nitroWorkflowOutfile);
        await rewriteWorkflowCodeLiteral(nitroWorkflowOutfile, this.#queueNamespace);
      }
    }

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
    let current = this.config.workingDir;

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
    bundleFinalOutput = true,
    discoveredEntries,
    format = "cjs",
    inputFiles,
    keepInterimBundleContext = this.config.watch,
    outfile,
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
    const output = await buildWithNitroRolldown({
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
        conditionNames: ["eve-source", "workflow", "node", "import", "default"],
        extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        mainFields: ["module", "main"],
      },
      tsconfig: tsconfigPath ?? false,
      write: false,
      output: {
        banner: "globalThis.__private_workflows = new Map();",
        codeSplitting: false,
        comments: false,
        format: "cjs",
        sourcemap: "inline",
      },
    });
    const interimBundle = getSingleRolldownChunk(
      output,
      `intermediate workflow bundle for "${outfile}"`,
    );

    await bundleFinalWorkflowOutput({
      bundleFinalOutput,
      code: interimBundle.code,
      format,
      outfile,
      queueNamespace: this.#queueNamespace,
      workingDir: this.config.workingDir,
    });

    if (keepInterimBundleContext) {
      return {
        bundleFinal: async (interimBundleResult: string) => {
          await bundleFinalWorkflowOutput({
            bundleFinalOutput,
            code: interimBundleResult,
            format,
            outfile,
            queueNamespace: this.#queueNamespace,
            workingDir: this.config.workingDir,
          });
        },
        interimBundleCtx: undefined,
        manifest: workflowManifest,
      };
    }

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

  async buildVercelOutput(options: {
    flowNitroOutputDir: string;
    outputDir: string;
    runtime?: string;
  }): Promise<void> {
    await this.build();

    const stagedWorkflowGeneratedDir = join(
      this.#outDir,
      "vercel-build-output",
      "functions",
      ".well-known",
      "workflow",
      "v1",
    );
    const stagedFlowFunctionDir = join(stagedWorkflowGeneratedDir, "flow.func");
    const workflowGeneratedDir = join(
      options.outputDir,
      "functions",
      ".well-known",
      "workflow",
      "v1",
    );
    const nitroFlowServerFunctionDir = join(
      options.flowNitroOutputDir,
      "functions",
      "__server.func",
    );
    const nitroFlowFunctionDir = join(
      options.flowNitroOutputDir,
      "functions",
      ".well-known",
      "workflow",
      "v1",
      "flow.func",
    );
    const flowFunctionDir = join(workflowGeneratedDir, "flow.func");
    const staleStepFunctionDir = join(workflowGeneratedDir, "step.func");
    const staleWebhookFunctionDir = join(workflowGeneratedDir, "webhook", "[token].func");

    await copyNitroFunctionDirectory({
      fallbackPath: nitroFlowServerFunctionDir,
      sourcePath: nitroFlowFunctionDir,
      targetPath: stagedFlowFunctionDir,
    });

    await Promise.all([
      this.#patchVercelFunctionConfig(stagedFlowFunctionDir, {
        experimentalTriggers: [createEveWorkflowQueueTrigger(this.#agentName)],
        maxDuration: "max",
        runtime: options.runtime ?? null,
        shouldAddHelpers: false,
      }),
      cp(join(this.#outDir, "manifest.json"), join(stagedWorkflowGeneratedDir, "manifest.json")),
    ]);
    await retargetNitroFunctionDirectoryToWorkflowRoute({
      functionDirectoryPath: stagedFlowFunctionDir,
      workflowRoutePath: "/.well-known/workflow/v1/flow",
    });

    await Promise.all([
      rm(flowFunctionDir, {
        force: true,
        recursive: true,
      }),
      rm(staleStepFunctionDir, {
        force: true,
        recursive: true,
      }),
      rm(staleWebhookFunctionDir, {
        force: true,
        recursive: true,
      }),
    ]);
    await mkdir(workflowGeneratedDir, { recursive: true });
    await Promise.all([
      cp(stagedFlowFunctionDir, flowFunctionDir, { recursive: true }),
      cp(
        join(stagedWorkflowGeneratedDir, "manifest.json"),
        join(workflowGeneratedDir, "manifest.json"),
      ),
    ]);
  }

  async #getBuildInputFiles(): Promise<string[]> {
    const inputFiles = await this.getInputFiles();
    return [...inputFiles, this.#compiledArtifactsBootstrapPath];
  }

  async #patchVercelFunctionConfig(
    directoryPath: string,
    patch: {
      experimentalTriggers?: readonly unknown[];
      maxDuration?: number | "max";
      runtime?: string | null;
      shouldAddHelpers?: boolean;
      shouldAddSourcemapSupport?: boolean;
    },
  ): Promise<void> {
    const configPath = join(directoryPath, ".vc-config.json");
    const baseConfig = await this.#readVercelFunctionConfig(configPath);
    const nextConfig: Record<string, unknown> = {
      ...baseConfig,
    };
    nextConfig.environment = createWorkflowFunctionEnvironment(baseConfig.environment);

    if (patch.runtime !== null) {
      nextConfig.runtime = patch.runtime;
    }

    if (patch.maxDuration !== undefined) {
      nextConfig.maxDuration = patch.maxDuration;
    }

    if (patch.shouldAddHelpers !== undefined) {
      nextConfig.shouldAddHelpers = patch.shouldAddHelpers;
    }

    if (patch.shouldAddSourcemapSupport !== undefined) {
      nextConfig.shouldAddSourcemapSupport = patch.shouldAddSourcemapSupport;
    }

    if (patch.experimentalTriggers !== undefined) {
      nextConfig.experimentalTriggers = [...patch.experimentalTriggers];
    }

    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  async #readVercelFunctionConfig(configPath: string): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }

    return {};
  }
}

async function addStepRegistrationsImport(
  workflowBundlePath: string,
  stepRegistrationsPath: string,
): Promise<void> {
  const source = await readTextFileIfPresent(workflowBundlePath);

  if (source === null || source.includes("__eveWorkflowStepsRegistered")) {
    return;
  }

  const importSpecifier = createRelativeImportSpecifier(
    dirname(workflowBundlePath),
    stepRegistrationsPath,
  );
  const importSource = [
    `import { __steps_registered as __eveWorkflowStepsRegistered } from ${JSON.stringify(importSpecifier)};`,
    "void __eveWorkflowStepsRegistered;",
    "",
  ].join("\n");
  const firstImportMatch = source.match(/^import\s.+?;\n/m);

  if (firstImportMatch === null || firstImportMatch.index === undefined) {
    await atomicWriteFile(workflowBundlePath, `${importSource}${source}`);
    return;
  }

  const insertionIndex = firstImportMatch.index + firstImportMatch[0].length;
  const nextSource = `${source.slice(0, insertionIndex)}${importSource}${source.slice(insertionIndex)}`;

  await atomicWriteFile(workflowBundlePath, nextSource);
}

async function rewriteWorkflowRuntimeImports(filePath: string): Promise<void> {
  const source = await readTextFileIfPresent(filePath);

  if (source === null) {
    return;
  }

  let nextSource = source;

  for (const specifier of [
    "workflow",
    "workflow/api",
    "workflow/internal/builtins",
    "workflow/internal/private",
    "workflow/runtime",
  ]) {
    const resolvedSpecifier = normalizeImportSpecifierPath(resolveWorkflowModulePath(specifier));
    nextSource = replaceStringLiteralSpecifier(nextSource, specifier, resolvedSpecifier);
  }

  if (nextSource !== source) {
    await atomicWriteFile(filePath, nextSource);
  }
}

async function rewriteWorkflowCodeLiteral(filePath: string, queueNamespace: string): Promise<void> {
  const source = await readTextFileIfPresent(filePath);

  if (source === null) {
    return;
  }

  const declarationPrefix = "const workflowCode = ";
  const declarationSuffix = `;\n\nexport const POST = workflowEntrypoint(workflowCode, { namespace: ${JSON.stringify(queueNamespace)} });`;
  const expressionStart = source.indexOf(declarationPrefix);
  const expressionEnd = source.lastIndexOf(declarationSuffix);

  if (expressionStart === -1 || expressionEnd === -1 || expressionEnd <= expressionStart) {
    return;
  }

  const valueStart = expressionStart + declarationPrefix.length;
  const expression = source.slice(valueStart, expressionEnd);

  if (!expression.trimStart().startsWith("`")) {
    return;
  }

  const workflowCode = decodeWorkflowCodeTemplateLiteral(expression, filePath);
  const nextSource = `${source.slice(0, valueStart)}${encodeWorkflowCodeLiteral(workflowCode)}${source.slice(
    expressionEnd,
  )}`;

  if (nextSource !== source) {
    await atomicWriteFile(filePath, nextSource);
  }
}

function encodeWorkflowCodeLiteral(workflowCode: string): string {
  const encodedWorkflowCode = Buffer.from(workflowCode, "utf8").toString("base64");
  const chunks = encodedWorkflowCode.match(/.{1,16384}/g) ?? [""];

  return `Buffer.from(${JSON.stringify(chunks)}.join(""), "base64").toString("utf8")`;
}

function decodeWorkflowCodeTemplateLiteral(expression: string, filePath: string): string {
  const trimmedExpression = expression.trim();

  if (!trimmedExpression.startsWith("`") || !trimmedExpression.endsWith("`")) {
    throw new Error(`Expected generated workflow code literal in "${filePath}" to be a template.`);
  }

  const rawValue = trimmedExpression.slice(1, -1);
  let value = "";

  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index];

    if (char !== "\\") {
      value += char;
      continue;
    }

    const escapedChar = rawValue[index + 1];

    if (escapedChar === "\\" || escapedChar === "`" || escapedChar === "$") {
      value += escapedChar;
      index += 1;
      continue;
    }

    value += char;
  }

  return value;
}

function replaceStringLiteralSpecifier(source: string, from: string, to: string): string {
  return source
    .replaceAll(JSON.stringify(from), JSON.stringify(to))
    .replaceAll(`'${from}'`, JSON.stringify(to));
}

function normalizeImportSpecifierPath(path: string): string {
  return normalizeEsmImportSpecifier(path);
}

function createRelativeImportSpecifier(fromDirectoryPath: string, targetPath: string): string {
  const relativePath = relative(fromDirectoryPath, targetPath).replaceAll("\\", "/");

  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

async function readTextFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readBinaryFileIfPresent(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function mirrorFileBypassingUnlink(sourcePath: string, targetPath: string): Promise<void> {
  const sourceContents = await readFile(sourcePath);
  const existingContents = await readBinaryFileIfPresent(targetPath);

  if (existingContents !== null && existingContents.equals(sourceContents)) {
    return;
  }

  await atomicWriteFile(targetPath, sourceContents);
}
