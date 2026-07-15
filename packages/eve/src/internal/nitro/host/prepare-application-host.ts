import { compileAgentInWorkspace, type CompileAgentResult } from "#compiler/compile-agent.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { resolveSchedules } from "#runtime/schedules/resolve-schedule.js";
import type { ResolvedScheduleDefinition } from "#runtime/types.js";
import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
import { join } from "node:path";
import {
  type BuiltInWorkflowWorldTarget,
  writeCompiledArtifactsFiles,
  writeDevelopmentCompiledArtifactsFiles,
} from "#internal/application/compiled-artifacts.js";
import {
  discardDevelopmentGeneration,
  stageDevelopmentGeneration,
} from "#internal/nitro/development-generation.js";
import {
  createDevelopmentHostWorkspace,
  removeDevelopmentHostWorkspace,
} from "#internal/nitro/host/dev-host-workspace.js";
import type {
  PreparedApplicationHost,
  PreparedDevelopmentApplicationHost,
} from "#internal/nitro/host/types.js";

/**
 * Compiles one authored app and stages an isolated runtime generation and host
 * candidate without changing the active development server.
 */
export async function prepareDevelopmentApplicationHost(
  appRoot: string,
): Promise<PreparedDevelopmentApplicationHost> {
  const workspace = await createDevelopmentHostWorkspace(appRoot);
  let generation: Awaited<ReturnType<typeof stageDevelopmentGeneration>> | undefined;

  try {
    const compileResult = await compileAgentInWorkspace({
      artifactLocations: {
        publishedRoot: join(appRoot, ".eve"),
        writeRoot: workspace.compilerArtifactsDir,
      },
      startPath: appRoot,
    });
    const schedules = await resolveSchedules({ manifest: compileResult.manifest });
    generation = await stageDevelopmentGeneration(compileResult);
    const compiledArtifacts = await writeDevelopmentCompiledArtifactsFiles({
      compileResult,
      outDir: workspace.artifactsDir,
      runtimeAppRoot: generation.runtimeAppRoot,
    });
    return {
      ...createPreparedApplicationHost({
        compileResult,
        compiledArtifacts,
        schedules,
        workflowBuildDir: workspace.workflowBuildDir,
      }),
      generation,
      workspace,
    };
  } catch (error) {
    const cleanupOperations: Promise<void>[] = [removeDevelopmentHostWorkspace(workspace)];
    if (generation !== undefined) {
      cleanupOperations.push(discardDevelopmentGeneration(generation));
    }
    const cleanup = await Promise.allSettled(cleanupOperations);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Failed to prepare and discard a development host candidate.",
        { cause: error },
      );
    }
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
  const compileResult = await compileAgentInWorkspace({
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
