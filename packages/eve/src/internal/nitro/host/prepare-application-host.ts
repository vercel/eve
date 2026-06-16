import { readFile } from "node:fs/promises";

import { compileAgent } from "#compiler/compile-agent.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";
import { writeCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import { resolveWorkflowBuildDirectory } from "#internal/application/paths.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  stageDevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

/**
 * Compiles one authored app and stages the package-owned artifacts needed by
 * the Nitro host.
 */
export async function prepareApplicationHost(
  startPath: string,
  options: {
    readonly dev?: boolean;
  } = {},
): Promise<PreparedApplicationHost> {
  const compileResult = await compileAgent({
    startPath,
  });
  const schedules = await loadResolvedCompiledSchedules({
    compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
      compileResult.project.appRoot,
    ),
  });
  const scheduleRegistrations = createScheduleRegistrations(schedules);
  const workflowBuildDir = resolveWorkflowBuildDirectory(compileResult.project.appRoot);
  const runtimeArtifactsSnapshot =
    options.dev === true
      ? await stageDevelopmentRuntimeArtifactsSnapshot(compileResult)
      : undefined;
  const runtimeArtifactsRoot =
    runtimeArtifactsSnapshot === undefined
      ? compileResult.project.appRoot
      : runtimeArtifactsSnapshot.runtimeAppRoot;
  const runtimeArtifactPaths = resolveRuntimeCompilerArtifactPaths(runtimeArtifactsRoot);
  const runtimeCompileResult =
    options.dev === true
      ? {
          ...compileResult,
          manifest: JSON.parse(
            await readFile(runtimeArtifactPaths.compiledManifestPath, "utf8"),
          ) as CompiledAgentManifest,
        }
      : compileResult;
  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult: runtimeCompileResult,
    outDir: runtimeArtifactPaths.compileDirectoryPath,
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
