import { defineState } from "eve/context";

import type { RepositoryInstructionFile } from "../extension.ts";
import { isPathWithinRoot } from "./repositories.ts";

export const MAX_CHECKED_DIRS = 500;

export interface RecordedRepository {
  readonly root: string;
  readonly slug: string | null;
  readonly remote: string | null;
  readonly head: string | null;
  readonly branch: string | null;
  readonly sparse: boolean;
  readonly instructions: readonly RepositoryInstructionFile[];
  readonly ruleFiles: readonly RepositoryInstructionFile[];
  readonly ruleInstructions: readonly string[];
}

export interface RecordedScope {
  readonly dir: string;
  readonly repoRoot: string | null;
  readonly repoSlug: string | null;
  readonly files: readonly RepositoryInstructionFile[];
}

export interface RepositorySessionState {
  readonly workspaceRoot: string | null;
  readonly rawWorkspaceRoot: string | null;
  readonly homeDir: string | null;
  readonly workspaceInstruction: readonly RepositoryInstructionFile[];
  readonly byRoot: Readonly<Record<string, RecordedRepository>>;
  readonly scopes: Readonly<Record<string, RecordedScope>>;
  readonly checkedDirs: readonly string[];
  readonly overflowPaths: readonly string[];
  readonly syncedTurnId: string | null;
}

export function initialRepositorySessionState(): RepositorySessionState {
  return {
    workspaceRoot: null,
    rawWorkspaceRoot: null,
    homeDir: null,
    workspaceInstruction: [],
    byRoot: {},
    scopes: {},
    checkedDirs: [],
    overflowPaths: [],
    syncedTurnId: null,
  };
}

export const repoState = defineState<RepositorySessionState>(
  "repositories",
  initialRepositorySessionState,
);

export function appendCheckedDirs(
  existing: readonly string[],
  added: readonly string[],
): readonly string[] {
  if (added.length === 0) return existing;
  const set = new Set(existing);
  for (const dir of added) {
    set.delete(dir);
    set.add(dir);
  }
  const list = [...set];
  return list.length > MAX_CHECKED_DIRS ? list.slice(list.length - MAX_CHECKED_DIRS) : list;
}

export function invalidateRepoCheckedDirs(
  existing: readonly string[],
  repoRoot: string,
): readonly string[] {
  return existing.filter((dir) => !isPathWithinRoot(dir, repoRoot));
}
