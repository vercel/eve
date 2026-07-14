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
  writeDevelopmentCompiledArtifactsFiles,
} from "#internal/application/compiled-artifacts.js";
import {
  resolveApplicationHostArtifactsDirectory,
  resolveWorkflowBuildDirectory,
} from "#internal/application/paths.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  activateDevelopmentGeneration,
  discardDevelopmentGeneration,
  stageDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
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
  const generation = await stageDevelopmentGeneration(compileResult);

  try {
    const compiledArtifacts = await writeDevelopmentCompiledArtifactsFiles({
      compileResult,
      outDir: resolveApplicationHostArtifactsDirectory(compileResult.project.appRoot),
      runtimeAppRoot: generation.runtimeAppRoot,
    });
    await activateDevelopmentGeneration({
      appRoot: compileResult.project.appRoot,
      generation,
    });
    return createPreparedApplicationHost({
      compileResult,
      compiledArtifacts,
      schedules,
      workflowBuildDir: resolveWorkflowBuildDirectory(compileResult.project.appRoot),
    });
  } catch (error) {
    await discardDevelopmentGeneration(generation);
    throw error;
  }
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

  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult,
    defaultWorkflowWorld: resolveProductionWorkflowWorldTarget(),
    outDir: workspace.host.artifactsDir,
  });

  return createPreparedApplicationHost({
    compileResult,
    compiledArtifacts,
    schedules,
    workflowBuildDir: workspace.workflow.buildDir,
  });
}

function createPreparedApplicationHost(input: {
  readonly compileResult: CompileAgentResult;
  readonly compiledArtifacts: PreparedApplicationHost["compiledArtifacts"];
  readonly schedules: readonly ResolvedScheduleDefinition[];
  readonly workflowBuildDir: string;
}): PreparedApplicationHost {
  return {
    appRoot: input.compileResult.project.appRoot,
    compileResult: input.compileResult,
    compiledArtifacts: input.compiledArtifacts,
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
