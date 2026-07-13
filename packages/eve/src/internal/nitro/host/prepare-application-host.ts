import { compileAgent } from "#compiler/compile-agent.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import {
  loadResolvedCompiledSchedules,
  resolveSchedules,
} from "#runtime/schedules/resolve-schedule.js";
import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
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
 * Compiles one authored app and stages the package-owned artifacts needed by
 * the Nitro host.
 */
export async function prepareApplicationHost(
  startPath: string,
  options: {
    readonly dev?: boolean;
    readonly workspace?: Pick<
      ApplicationBuildWorkspace,
      "compilerArtifactsRoot" | "hostArtifactsDir" | "workflowBuildDir"
    >;
  } = {},
): Promise<PreparedApplicationHost> {
  const compileResult = await compileAgent({
    artifactsRoot: options.workspace?.compilerArtifactsRoot,
    includeDiagnosticsArtifactPath: options.workspace === undefined,
    startPath,
  });
  const schedules =
    options.workspace === undefined
      ? await loadResolvedCompiledSchedules({
          compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
            compileResult.project.appRoot,
          ),
        })
      : await resolveSchedules({ manifest: compileResult.manifest });
  const scheduleRegistrations = createScheduleRegistrations(schedules);
  const workflowBuildDir =
    options.workspace?.workflowBuildDir ??
    resolveWorkflowBuildDirectory(compileResult.project.appRoot);
  const runtimeArtifactsSnapshot =
    options.dev === true
      ? await stageDevelopmentRuntimeArtifactsSnapshot(compileResult)
      : undefined;
  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult,
    defaultWorkflowWorld: resolveDefaultWorkflowWorld(options),
    outDir:
      options.workspace?.hostArtifactsDir ??
      resolveApplicationHostArtifactsDirectory(compileResult.project.appRoot),
  });
  if (runtimeArtifactsSnapshot !== undefined) {
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot: compileResult.project.appRoot,
      snapshot: runtimeArtifactsSnapshot,
    });
  }

  return {
    appRoot: compileResult.project.appRoot,
    compileResult,
    compiledArtifacts,
    scheduleRegistrations,
    schedules,
    workflowBuildDir,
  };
}

function resolveDefaultWorkflowWorld(options: {
  readonly dev?: boolean;
}): BuiltInWorkflowWorldTarget {
  if (options.dev === true) {
    return "local";
  }

  return process.env.VERCEL ? "vercel" : "local";
}
