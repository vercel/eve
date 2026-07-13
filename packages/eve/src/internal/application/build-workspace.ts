import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveOutputDirectory } from "#internal/application/paths.js";
import { VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH } from "#internal/vercel-agent-summary.js";

export interface ApplicationBuildWorkspace {
  readonly appRoot: string;
  readonly compilerAppRoot: string;
  readonly compilerArtifactsRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly hostArtifactsDir: string;
  readonly nitroBuildDir: string;
  readonly nitroOutputDir: string;
  readonly outputDir: string;
  readonly rootDir: string;
  readonly summaryPath: string;
  readonly workflowBuildDir: string;
}

export async function createApplicationBuildWorkspace(
  appRoot: string,
): Promise<ApplicationBuildWorkspace> {
  const resolvedAppRoot = resolve(appRoot);
  const buildId = `${Date.now().toString(36)}-${randomUUID()}`;
  const rootDir = join(resolvedAppRoot, ".eve", "builds", buildId);
  const compilerAppRoot = join(rootDir, "compiler");
  const workspace: ApplicationBuildWorkspace = {
    appRoot: resolvedAppRoot,
    compilerAppRoot,
    compilerArtifactsRoot: join(compilerAppRoot, ".eve"),
    finalOutputDir: resolveOutputDirectory(resolvedAppRoot),
    finalSummaryPath: join(resolvedAppRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH),
    hostArtifactsDir: join(rootDir, "host"),
    nitroBuildDir: join(rootDir, "nitro"),
    nitroOutputDir: join(rootDir, "nitro-output"),
    outputDir: join(rootDir, "output"),
    rootDir,
    summaryPath: join(rootDir, "agent-summary.json"),
    workflowBuildDir: join(rootDir, "workflow"),
  };

  await mkdir(rootDir, { recursive: true });
  return workspace;
}

export async function removeApplicationBuildWorkspace(
  workspace: ApplicationBuildWorkspace,
): Promise<void> {
  await rm(workspace.rootDir, { force: true, recursive: true });
}
