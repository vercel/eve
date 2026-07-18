import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface DevelopmentHostWorkspace {
  readonly artifactsDir: string;
  readonly compilerArtifactsDir: string;
  readonly nitroBuildDir: string;
  readonly nitroOutputDir: string;
  readonly rootDir: string;
  readonly workflowBuildDir: string;
}

export async function createDevelopmentHostWorkspace(
  appRoot: string,
): Promise<DevelopmentHostWorkspace> {
  const rootDir = join(appRoot, ".eve", "dev-hosts", randomUUID());
  const workspace: DevelopmentHostWorkspace = {
    artifactsDir: join(rootDir, "artifacts"),
    compilerArtifactsDir: join(rootDir, "compiler"),
    nitroBuildDir: join(rootDir, "nitro"),
    nitroOutputDir: join(rootDir, "output"),
    rootDir,
    workflowBuildDir: join(rootDir, "workflow"),
  };

  await mkdir(rootDir, { recursive: true });
  return workspace;
}

export async function removeDevelopmentHostWorkspace(
  workspace: DevelopmentHostWorkspace,
): Promise<void> {
  await rm(workspace.rootDir, { force: true, recursive: true });
}
