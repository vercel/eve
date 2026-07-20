import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { initDataDir } from "@workflow/world-local";

import {
  resolvePackageRoot,
  resolvePackageSourceDirectoryPath,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { resolveWorkflowTestOutputDirectory } from "#internal/testing/workflow-vitest-plugin.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import {
  bundleWorkflowStepRegistrations,
  collectWorkflowInputFiles,
  type WorkflowBundleDiscoveredEntries,
} from "#internal/workflow-bundle/builder-support.js";
import { detectWorkflowPatterns } from "#internal/workflow-bundle/workflow-builders.js";
import { installEveWorkflowQueueNamespace } from "#internal/workflow/queue-namespace.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

export const WORKFLOW_TEST_AGENT_NAME = "eve-test";

export default async function setupWorkflowTests(): Promise<void> {
  const packageRoot = resolvePackageRoot();
  const outDir = resolveWorkflowTestOutputDirectory(packageRoot);
  const compiledArtifactsBootstrapPath = resolvePackageSourceFilePath(
    "test/setup/compiled-artifacts-bootstrap.mjs",
  );
  installEveWorkflowQueueNamespace(WORKFLOW_TEST_AGENT_NAME);

  const builder = new WorkflowBundleBuilder({
    agentName: WORKFLOW_TEST_AGENT_NAME,
    appRoot: packageRoot,
    compiledArtifactsBootstrapPath,
    includeTestFixtures: true,
    outDir,
    rootDir: packageRoot,
    watch: false,
  });

  await builder.build();
  await bundleWorkflowStepRegistrations({
    builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
    discoveredEntries: await discoverWorkflowEntries(),
    outfile: join(outDir, "steps.mjs"),
    projectRoot: packageRoot,
    tsconfigPath: join(packageRoot, "tsconfig.json"),
    workingDir: packageRoot,
  });
  await initDataDir(resolveLocalWorkflowWorldDataDirectory(packageRoot));
}

async function discoverWorkflowEntries(): Promise<WorkflowBundleDiscoveredEntries> {
  const inputFiles = [
    ...(await collectWorkflowInputFiles(resolvePackageSourceDirectoryPath("src/execution"))),
    ...(await collectWorkflowInputFiles(resolvePackageSourceDirectoryPath("src/internal/testing"))),
    resolvePackageSourceFilePath("test/setup/compiled-artifacts-bootstrap.mjs"),
  ];
  const discovered: WorkflowBundleDiscoveredEntries = {
    discoveredSerdeFiles: [],
    discoveredSteps: [],
    discoveredWorkflows: [],
  };

  for (const filePath of inputFiles) {
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

  return discovered;
}
