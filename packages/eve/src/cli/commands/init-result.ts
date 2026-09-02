import type { NodeEngineOverride } from "#setup/node-engine.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import type { WorkspaceRootMutation } from "#setup/scaffold/workspace-root.js";

import type { GitInitResult } from "./init-git.js";
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
  onboardingCompleted: boolean;
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
