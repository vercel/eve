import {
  compileAgent,
  compileAgentInBuildWorkspace,
  type CompileAgentResult,
} from "#compiler/compile-agent.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import {
  loadResolvedCompiledSchedules,
  resolveSchedules,
} from "#runtime/schedules/resolve-schedule.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
import { join } from "node:path";
import {
  type BuiltInWorkflowWorldTarget,
  writeCompiledArtifactsFiles,
} from "#internal/application/compiled-artifacts.js";
import {
  resolveApplicationHostArtifactsDirectory,
  resolveWorkflowBuildDirectory,
} from "#internal/application/paths.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  stageDevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

/**
 * Compiles one authored app in place and stages the package-owned artifacts
 * the dev-server Nitro host needs, activating a fresh runtime-artifacts
 * snapshot for hot reload.
 */
export async function prepareDevelopmentApplicationHost(
  startPath: string,
): Promise<PreparedApplicationHost> {
  const compileResult = await compileAgent({
    startPath,
  });
  const schedules = await loadResolvedCompiledSchedules({
    compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
      compileResult.project.appRoot,
    ),
  });
  const runtimeArtifactsSnapshot = await stageDevelopmentRuntimeArtifactsSnapshot(compileResult);
  const preparedHost = await materializeApplicationHost({
    compileResult,
    defaultWorkflowWorld: "local",
    hostArtifactsDir: resolveApplicationHostArtifactsDirectory(compileResult.project.appRoot),
    schedules,
    workflowBuildDir: resolveWorkflowBuildDirectory(compileResult.project.appRoot),
  });
  await activateDevelopmentRuntimeArtifactsSnapshot({
    appRoot: compileResult.project.appRoot,
    snapshot: runtimeArtifactsSnapshot,
  });

  return preparedHost;
}

/**
 * Compiles one authored app into an invocation-owned build workspace and
 * stages the package-owned artifacts the production Nitro build needs.
 * Compiler artifacts are written inside the workspace but their recorded
 * locations point at the published output (`<finalDir>/.eve`), where
 * publication later installs them.
 */
export async function prepareProductionApplicationHost(
  workspace: ApplicationBuildWorkspace,
): Promise<PreparedApplicationHost> {
  const compileResult = await compileAgentInBuildWorkspace({
    artifactLocations: {
      publishedRoot: join(workspace.publication.output.finalDir, ".eve"),
      writeRoot: workspace.compiler.artifactsDir,
    },
    startPath: workspace.appRoot,
  });
  const schedules = await resolveSchedules({ manifest: compileResult.manifest });

  return await materializeApplicationHost({
    compileResult,
    defaultWorkflowWorld: resolveProductionWorkflowWorldTarget(),
    hostArtifactsDir: workspace.host.artifactsDir,
    schedules,
    workflowBuildDir: workspace.workflow.buildDir,
  });
}

async function materializeApplicationHost(input: {
  readonly compileResult: CompileAgentResult;
  readonly defaultWorkflowWorld: BuiltInWorkflowWorldTarget;
  readonly hostArtifactsDir: string;
  readonly schedules: readonly ResolvedScheduleDefinition[];
  readonly workflowBuildDir: string;
}): Promise<PreparedApplicationHost> {
  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult: input.compileResult,
    defaultWorkflowWorld: input.defaultWorkflowWorld,
    outDir: input.hostArtifactsDir,
  });

  return {
    appRoot: input.compileResult.project.appRoot,
    compileResult: input.compileResult,
    compiledArtifacts,
    scheduleRegistrations: createScheduleRegistrations(input.schedules),
    schedules: input.schedules,
    workflowBuildDir: input.workflowBuildDir,
  };
}

function resolveProductionWorkflowWorldTarget(): BuiltInWorkflowWorldTarget {
  if (process.env.VERCEL) {
    return "vercel";
  }

  return "local";
}
