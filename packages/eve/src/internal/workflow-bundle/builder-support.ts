import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  buildWithNitroRolldown,
  getSingleRolldownChunk,
} from "#internal/bundler/nitro-rolldown.js";
import { resolveWorkflowModulePath } from "#internal/application/package.js";
import {
  applyWorkflowTransform,
  getImportPath,
  type WorkflowManifest,
} from "#internal/workflow-bundle/workflow-builders.js";
import { EVE_WORKFLOW_QUEUE_NAMESPACE } from "#internal/workflow/queue-namespace.js";
import { WORKFLOW_STEP_EXTERNAL_PACKAGES } from "#internal/workflow-bundle/vercel-workflow-output.js";

export const WORKFLOW_VIRTUAL_ENTRY_ID = "\0eve-workflow-entry";
const PSEUDO_PACKAGES = new Set([
  "server-only",
  "client-only",
  "next/dist/compiled/server-only",
  "next/dist/compiled/client-only",
]);
const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const WORKFLOW_INPUT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const IGNORED_INPUT_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".vercel",
  ".workflow-data",
  ".workflow-vitest",
  ".well-known",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".yarn",
  ".pnpm-store",
]);

export interface WorkflowBundleBuilderConfig {
  readonly buildTarget: "standalone";
  readonly dirs: readonly string[];
  readonly externalPackages: readonly string[];
  readonly projectRoot: string;
  readonly watch: boolean;
  readonly workingDir: string;
}

export interface WorkflowBundleDiscoveredEntries {
  readonly discoveredSerdeFiles: string[];
  readonly discoveredSteps: string[];
  readonly discoveredWorkflows: string[];
}

export interface WorkflowBundleCreateWorkflowsBundleOptions {
  readonly bundleFinalOutput?: boolean;
  readonly discoveredEntries?: WorkflowBundleDiscoveredEntries;
  readonly format?: "cjs" | "esm";
  readonly inputFiles: readonly string[];
  readonly keepInterimBundleContext?: boolean;
  readonly outfile: string;
  readonly tsconfigPath?: string;
}

export interface WorkflowBundleCreateWorkflowsBundleResult {
  readonly bundleFinal?: (interimBundleResult: string) => Promise<void>;
  readonly interimBundleCtx?: undefined;
  readonly manifest: WorkflowManifest;
}

interface WorkflowGraph {
  readonly edges: readonly unknown[];
  readonly nodes: readonly unknown[];
}

interface WorkflowRolldownPlugin {
  readonly name: string;
  readonly resolveId?: (source: string, importer?: string) => unknown;
  readonly load?: (id: string) => unknown;
  readonly transform?: (code: string, id: string) => unknown;
}

export async function collectWorkflowInputFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Array<{
      isDirectory(): boolean;
      isFile(): boolean;
      name: string;
    }>;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_INPUT_DIRECTORIES.has(entry.name)) {
          await visit(join(directory, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = entry.name.match(/\.[^.]+$/)?.[0];

      if (extension !== undefined && WORKFLOW_INPUT_EXTENSIONS.has(extension)) {
        files.push(join(directory, entry.name));
      }
    }
  }

  await visit(root);
  return files;
}

export function createWorkflowImport(filePath: string, workingDir: string): string {
  const { importPath, isPackage } = getImportPath(filePath, workingDir);

  if (isPackage) {
    return `import ${JSON.stringify(importPath)};`;
  }

  return `import ${JSON.stringify(toRelativeImportSpecifier(workingDir, filePath))};`;
}

export function createWorkflowVirtualEntryPlugin(source: string): WorkflowRolldownPlugin {
  return {
    name: "eve-workflow-virtual-entry",
    resolveId(id: string) {
      if (id === WORKFLOW_VIRTUAL_ENTRY_ID) {
        return { id };
      }

      return undefined;
    },
    load(id: string) {
      if (id !== WORKFLOW_VIRTUAL_ENTRY_ID) {
        return undefined;
      }

      return {
        code: source,
        moduleSideEffects: true,
        moduleType: "js",
      };
    },
  };
}

export function createWorkflowPseudoPackagePlugin(): WorkflowRolldownPlugin {
  return {
    name: "eve-workflow-pseudo-packages",
    resolveId(source: string) {
      if (!PSEUDO_PACKAGES.has(source)) {
        return undefined;
      }

      return { id: `\0eve-workflow-pseudo-package:${source}` };
    },
    load(id: string) {
      if (!id.startsWith("\0eve-workflow-pseudo-package:")) {
        return undefined;
      }

      return {
        code: "",
        moduleType: "js",
      };
    },
  };
}

export function createWorkflowRuntimeAliasPlugin(): WorkflowRolldownPlugin {
  return {
    name: "eve-workflow-runtime-aliases",
    resolveId(source: string) {
      if (source !== "workflow" && !source.startsWith("workflow/")) {
        return undefined;
      }

      return resolveWorkflowModulePath(source);
    },
  };
}

export function createEvePackageImportsPlugin(
  workingDir: string,
  options: { workflowCondition?: boolean } = {},
): WorkflowRolldownPlugin {
  return {
    name: "eve-package-imports",
    resolveId(source: string) {
      const compiledSubpath = source.match(/^#compiled\/(.+)$/)?.[1];

      if (compiledSubpath !== undefined) {
        if (options.workflowCondition === true && compiledSubpath === "@workflow/core/index.js") {
          return resolveFirstExistingPath([
            join(workingDir, "src", "internal", "workflow-bundle", "workflow-core-shim.ts"),
            join(workingDir, "dist", "src", "internal", "workflow-bundle", "workflow-core-shim.js"),
          ]);
        }

        return resolveFirstExistingPath([
          join(workingDir, ".generated", "compiled", compiledSubpath),
          join(workingDir, "dist", "src", "compiled", compiledSubpath),
        ]);
      }

      const sourceSubpath = source.match(/^#(.+)\.js$/)?.[1];

      if (sourceSubpath === undefined) {
        return undefined;
      }

      return resolveFirstExistingPath(
        [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].flatMap((extension) => [
          join(workingDir, "src", `${sourceSubpath}${extension}`),
          join(workingDir, "dist", "src", `${sourceSubpath}${extension}`),
        ]),
      );
    },
  };
}

export function createWorkflowTransformPlugin(input: {
  manifest: WorkflowManifest;
  mode?: "step" | "workflow";
  projectRoot: string;
  sideEffectFiles?: readonly string[];
  workingDir: string;
}): WorkflowRolldownPlugin {
  const sideEffectFiles = new Set(
    input.sideEffectFiles?.map((filePath) => filePath.replaceAll("\\", "/")) ?? [],
  );

  return {
    name: "eve-workflow-transform",
    async load(id: string) {
      if (!isJavaScriptLikePath(id)) {
        return undefined;
      }

      const code = await readFile(id, "utf8");
      const relativeFilepath = createManifestRelativeFilepath(input.workingDir, id);
      const transformed = await applyWorkflowTransform(
        relativeFilepath,
        code
          .replace(/require\(\s*(['"])server-only\1\s*\)/g, "void 0")
          .replace(/require\(\s*(['"])client-only\1\s*\)/g, "void 0"),
        input.mode ?? "workflow",
        id,
        input.projectRoot,
      );

      mergeWorkflowManifest(input.manifest, transformed.workflowManifest);

      return {
        code: transformed.code,
        map: null,
        moduleSideEffects: sideEffectFiles.has(id.replaceAll("\\", "/")) || undefined,
      };
    },
  };
}

export async function bundleWorkflowStepRegistrations(input: {
  builtinsPath: string;
  discoveredEntries: WorkflowBundleDiscoveredEntries;
  outfile: string;
  projectRoot: string;
  tsconfigPath?: string;
  workingDir: string;
}): Promise<void> {
  const stepFiles = [...input.discoveredEntries.discoveredSteps].sort();
  const stepFileSet = new Set(stepFiles);
  const serdeOnlyFiles = [...input.discoveredEntries.discoveredSerdeFiles]
    .sort()
    .filter((filePath) => !stepFileSet.has(filePath));
  const manifest: WorkflowManifest = {};
  const virtualEntrySource = [
    createWorkflowImport(input.builtinsPath, input.workingDir),
    ...stepFiles.map((filePath) => createWorkflowImport(filePath, input.workingDir)),
    ...serdeOnlyFiles.map((filePath) => createWorkflowImport(filePath, input.workingDir)),
    "export const __steps_registered = true;",
  ].join("\n");
  const output = await buildWithNitroRolldown({
    cwd: input.workingDir,
    input: WORKFLOW_VIRTUAL_ENTRY_ID,
    // Optional runtime packages (the just-bash sandbox engine and its
    // native codecs) resolve lazily against the application install at
    // run time; inlining them would drag platform-specific `.node`
    // binaries into the step bundle.
    external: isWorkflowStepExternalPackage,
    platform: "node",
    plugins: [
      createWorkflowVirtualEntryPlugin(virtualEntrySource),
      createWorkflowPseudoPackagePlugin(),
      createWorkflowRuntimeAliasPlugin(),
      createEvePackageImportsPlugin(input.workingDir),
      createWorkflowTransformPlugin({
        manifest,
        mode: "step",
        projectRoot: input.projectRoot,
        sideEffectFiles: [...stepFiles, ...serdeOnlyFiles],
        workingDir: input.workingDir,
      }),
    ],
    resolve: {
      conditionNames: ["eve-source", "node", "import", "default"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["module", "main"],
    },
    tsconfig: input.tsconfigPath ?? false,
    write: false,
    output: {
      codeSplitting: false,
      comments: false,
      format: "esm",
      sourcemap: "inline",
    },
  });
  const chunk = getSingleRolldownChunk(output, `step registrations bundle for "${input.outfile}"`);
  await writeWorkflowBundleAtomically(input.outfile, chunk.code);
}

function isWorkflowStepExternalPackage(source: string): boolean {
  return WORKFLOW_STEP_EXTERNAL_PACKAGES.some(
    (packageName) => source === packageName || source.startsWith(`${packageName}/`),
  );
}

export function createWorkflowNodeBuiltinGuardPlugin(): WorkflowRolldownPlugin {
  return {
    name: "eve-workflow-node-builtins",
    resolveId(source: string, importer?: string) {
      const moduleName = source.startsWith("node:") ? source.slice("node:".length) : source;

      if (!NODE_BUILTIN_MODULES.has(source) && !NODE_BUILTIN_MODULES.has(moduleName)) {
        return undefined;
      }

      // Name the importer so the offending edge is obvious instead of
      // failing later at run time with a bare "require is not defined".
      const via = importer ? ` (imported by "${importer}")` : "";
      throw new Error(
        `Workflow bundle cannot import Node.js builtin "${source}"${via}. ` +
          `Move Node.js APIs behind a "use step" function, or keep the importing ` +
          `module out of the workflow driver body (only reachable through a "use step").`,
      );
    },
  };
}

export async function bundleFinalWorkflowOutput(input: {
  bundleFinalOutput: boolean;
  code: string;
  format: "cjs" | "esm";
  outfile: string;
  workingDir: string;
}): Promise<void> {
  const workflowBundleCode = input.code.endsWith("\n") ? input.code : `${input.code}\n`;
  const workflowFunctionCode = `// biome-ignore-all lint: generated file
/* eslint-disable */
import { workflowEntrypoint } from 'workflow/runtime';

const workflowCode = \`${workflowBundleCode.replace(/[\\`$]/g, "\\$&")}\`;

export const POST = workflowEntrypoint(workflowCode, { namespace: ${JSON.stringify(EVE_WORKFLOW_QUEUE_NAMESPACE)} });`;

  if (!input.bundleFinalOutput) {
    await writeWorkflowBundleAtomically(input.outfile, workflowFunctionCode);
    return;
  }

  const output = await buildWithNitroRolldown({
    cwd: input.workingDir,
    input: WORKFLOW_VIRTUAL_ENTRY_ID,
    external: (source: string) => source === "@aws-sdk/credential-provider-web-identity",
    platform: "node",
    plugins: [createWorkflowVirtualEntryPlugin(workflowFunctionCode)],
    write: false,
    output: {
      comments: false,
      format: input.format,
      sourcemap: false,
    },
  });
  const chunk = getSingleRolldownChunk(output, `final workflow bundle for "${input.outfile}"`);
  await writeWorkflowBundleAtomically(input.outfile, chunk.code);
}

export function convertStepsManifest(steps: WorkflowManifest["steps"]): Record<string, unknown> {
  const result: Record<string, Record<string, { stepId: string }>> = {};

  for (const [filePath, entries] of Object.entries(steps ?? {})) {
    result[filePath] = {};

    for (const [name, data] of Object.entries(entries)) {
      result[filePath][name] = { stepId: data.stepId };
    }
  }

  return result;
}

export function convertWorkflowsManifest(
  workflows: WorkflowManifest["workflows"],
): Record<string, unknown> {
  const result: Record<string, Record<string, { graph: WorkflowGraph; workflowId: string }>> = {};

  for (const [filePath, entries] of Object.entries(workflows ?? {})) {
    result[filePath] = {};

    for (const [name, data] of Object.entries(entries)) {
      result[filePath][name] = {
        graph: { edges: [], nodes: [] },
        workflowId: data.workflowId,
      };
    }
  }

  return result;
}

export function convertClassesManifest(
  classes: WorkflowManifest["classes"],
): Record<string, unknown> {
  const result: Record<string, Record<string, { classId: string }>> = {};

  for (const [filePath, entries] of Object.entries(classes ?? {})) {
    result[filePath] = {};

    for (const [name, data] of Object.entries(entries)) {
      result[filePath][name] = { classId: data.classId };
    }
  }

  return result;
}

function toRelativeImportSpecifier(fromDirectory: string, targetPath: string): string {
  const relativePath = relative(fromDirectory, targetPath).replaceAll("\\", "/");

  if (relativePath.startsWith("./") || relativePath.startsWith("../")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

function resolveFirstExistingPath(paths: readonly string[]): { id: string } | undefined {
  for (const path of paths) {
    if (existsSync(path)) {
      return { id: resolve(path) };
    }
  }

  return undefined;
}

async function writeWorkflowBundleAtomically(outfile: string, source: string): Promise<void> {
  await mkdir(dirname(outfile), { recursive: true });
  const tempPath = `${outfile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, source);
  await rename(tempPath, outfile);
}

function mergeWorkflowManifest(target: WorkflowManifest, source: WorkflowManifest): void {
  target.steps = mergeWorkflowManifestSection(target.steps, source.steps);
  target.workflows = mergeWorkflowManifestSection(target.workflows, source.workflows);
  target.classes = mergeWorkflowManifestSection(target.classes, source.classes);
}

function mergeWorkflowManifestSection<
  TSection extends Record<string, Record<string, object>> | undefined,
>(target: TSection, source: TSection): TSection {
  if (source === undefined) {
    return target;
  }

  const nextSection = {
    ...target,
  } as Record<string, Record<string, object>>;

  for (const [relativeFileName, entries] of Object.entries(source)) {
    nextSection[relativeFileName] = {
      ...nextSection[relativeFileName],
      ...entries,
    };
  }

  return nextSection as TSection;
}

function createManifestRelativeFilepath(workingDir: string, absolutePath: string): string {
  const normalizedFile = absolutePath.replaceAll("\\", "/");
  const normalizedWorkingDir = workingDir.replaceAll("\\", "/");
  let relativePath = relative(normalizedWorkingDir, normalizedFile).replaceAll("\\", "/");

  if (relativePath.startsWith("../")) {
    relativePath = relativePath
      .split("/")
      .filter((part) => part !== "..")
      .join("/");
  }

  return relativePath;
}

function isJavaScriptLikePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(path);
}

/*
 * Some generated workflow artifacts (notably `workflows.mjs`) are read by
 * Nitro's Rolldown bundler concurrently with rebuilds during `eve dev`. A
 * plain `writeFile` truncates the target first and streams bytes, so a
 * reader can observe an empty or partial module mid-write and report
 * spurious "missing export" errors. Writing to a sibling temp file and
 * renaming relies on POSIX `rename` atomicity so readers always see
 * either the old or the new contents.
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Buffer | Uint8Array,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmpPath, contents);
  await rename(tmpPath, targetPath);
}
