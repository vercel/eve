import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveWorkflowModulePath } from "#internal/application/package.js";
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";
import {
  createEvePackageImportsPlugin,
  createWorkflowImport,
  createWorkflowPseudoPackagePlugin,
  createWorkflowTransformPlugin,
  createWorkflowVirtualEntryPlugin,
  WORKFLOW_SOURCE_EXTENSIONS,
  WORKFLOW_VIRTUAL_ENTRY_ID,
  type WorkflowBundleDiscoveredEntries,
} from "#internal/workflow-bundle/builder-support.js";
import { WORKFLOW_STEP_EXTERNAL_PACKAGES } from "#internal/workflow-bundle/vercel-workflow-output.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";

/**
 * Bundles step registrations for the Vitest workflow world. Hosted builds let
 * Nitro bundle the raw `steps.mjs` entrypoint; tests load it directly, so the
 * step-mode transform has to be applied here.
 */
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
  const chunk = await buildSingleRolldownChunk(`step registrations bundle for "${input.outfile}"`, {
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
      {
        name: "eve-workflow-runtime-aliases",
        resolveId(source: string) {
          if (source !== "workflow" && !source.startsWith("workflow/")) {
            return undefined;
          }

          return resolveWorkflowModulePath(source);
        },
      },
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
      conditionNames: ["eve-source"],
      extensions: WORKFLOW_SOURCE_EXTENSIONS,
      mainFields: ["module", "main"],
    },
    tsconfig: input.tsconfigPath ?? false,
    output: {
      comments: false,
      format: "esm",
      sourcemap: "inline",
    },
  });
  await mkdir(dirname(input.outfile), { recursive: true });
  await atomicWriteFile(input.outfile, chunk.code);
}

function isWorkflowStepExternalPackage(source: string): boolean {
  return WORKFLOW_STEP_EXTERNAL_PACKAGES.some(
    (packageName) => source === packageName || source.startsWith(`${packageName}/`),
  );
}
