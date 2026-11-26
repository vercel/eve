import { defineState } from "eve/context";

import type { RepositoryInstructionFile } from "../extension.ts";

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
  readonly enteredAtHead: string | null;
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
  readonly revision: number;
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
    revision: 0,
  };
}

export const repoState = defineState<RepositorySessionState>(
  "repositories",
  initialRepositorySessionState,
);

export function appendOverflowPaths(
  existing: readonly string[],
  added: readonly string[],
  maxPaths: number,
): readonly string[] {
  if (added.length === 0 && existing.length <= maxPaths) return existing;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const p of [...existing, ...added]) {
    if (result.length >= maxPaths) break;
    if (p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    result.push(p);
  }
  return result;
}

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
  const prefix = repoRoot === "/" ? "/" : `${repoRoot}/`;
  return existing.filter((dir) => dir !== repoRoot && !dir.startsWith(prefix));
}
