import { relative } from "node:path";

import pc from "#compiled/picocolors/index.js";

import { formatNodeEngineOverrideWarning, type NodeEngineOverride } from "#setup/node-engine.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import type { WorkspaceRootMutation } from "#setup/scaffold/workspace-root.js";

import type { GitInitResult } from "./init-git.js";
import type { InitCliLogger } from "./init-agent-workspace.js";
import type { InitFailurePolicy } from "./init-recovery.js";

export type PreparedInitProject =
  | {
      configurationFilesChanged: string[];
      dependenciesAdded: string[];
      failurePolicy: "preserve";
      filesWritten: string[];
      kind: "added";
      nodeEngineOverride?: NodeEngineOverride;
      packageManager: PackageManagerKind;
      projectPath: string;
    }
  | {
      failurePolicy: InitFailurePolicy;
      kind: "created";
      packageManager: PackageManagerKind;
      preservedTargetEntries: readonly string[];
      projectPath: string;
      retryCommand: string;
      workspaceMember: boolean;
      workspaceRootMutations: WorkspaceRootMutation[];
    };

export type InitResult = {
  agentElapsedMs: number;
  agentLaunched: boolean;
  installElapsedMs: number;
  packageManager: PackageManagerKind;
  projectPath: string;
  selfModificationEnabled: boolean;
} & (
  | {
      configurationFilesChanged: string[];
      dependenciesAdded: string[];
      filesWritten: string[];
      kind: "added";
      nodeEngineOverride?: NodeEngineOverride;
    }
  | {
      gitResult: GitInitResult;
      kind: "created";
      workspaceRootMutations: WorkspaceRootMutation[];
    }
);

export function reportExistingProjectChanges(
  logger: InitCliLogger,
  project: Extract<PreparedInitProject, { kind: "added" }>,
): void {
  logger.log("Updated existing project:");
  for (const path of project.filesWritten) {
    logger.log(`  Created ${relative(project.projectPath, path).replaceAll("\\", "/")}`);
  }
  if (project.dependenciesAdded.length > 0) {
    logger.log(`  Added dependencies: ${project.dependenciesAdded.join(", ")}`);
  }
  for (const path of project.configurationFilesChanged) {
    logger.log(`  Updated ${path}`);
  }
  if (project.nodeEngineOverride !== undefined) {
    logger.log(pc.yellow(`  ⚠ ${formatNodeEngineOverrideWarning(project.nodeEngineOverride)}`));
  }
}
