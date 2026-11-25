import { posix } from "node:path";
import type { CallObservation } from "eve/events";
import type { RuntimeSandboxSession } from "eve/sandbox";
import type { SkillDefinition } from "eve/skills";
import { toolResultFrom, type ToolDefinition } from "eve/tools";

import type {
  DiscoveredRepository,
  EnteredRepository,
  RepositoryInstructionFile,
  RepositoryInstructionSpec,
  RepositoryRuleContext,
} from "../extension.ts";
import {
  appendCheckedDirs,
  invalidateRepoCheckedDirs,
  isValidRepositorySkillName,
  MAX_PENDING_BACKGROUND_JOBS,
  repoState,
  serializeSkill,
  type PendingBackgroundJob,
  type PendingRepositoryReconcile,
  type RecordedRepository,
  type RecordedScope,
  type RepositorySessionState,
  type SerializedSkillDefinition,
} from "./repo-state.ts";
import {
  computeAncestorDirs,
  discoverWorkspace,
  isWindowsDrivePath,
  matchesRepositoryRule,
  normalizePlatformPath,
  readRepositoryFile,
  readRepositorySpecFiles,
  readScopedDirectoryInstructions,
  type RepositorySandbox,
  type ResolvedRepositoriesConfig,
} from "./repositories.ts";

const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file", "glob", "grep"]);
const DIRECTORY_TOOLS = new Set(["glob", "grep"]);
const MAX_EXTRA_PATHS = 8;

const COMMAND_RECONCILE_PATTERN =
  /\b(?:git|gh|clone|checkout|switch|fetch|pull|worktree|submodule|sparse-checkout|reset|init|tar|unzip|cd)\b/u;

export type SettledCallAction =
  | { readonly kind: "none" }
  | {
      readonly kind: "file";
      readonly targetPath: string;
      readonly isDirectory: boolean;
    }
  | {
      readonly kind: "reconcile";
      readonly extraPaths: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isBackgroundBashOutput(output: unknown): boolean {
  return isRecord(output) && output.status === "running";
}

export function extractBackgroundBashJob(
  output: unknown,
  extraPaths: readonly string[],
): PendingBackgroundJob | null {
  if (!isBackgroundBashOutput(output)) return null;
  const outputDirectory = readStringField(output, "outputDirectory");
  if (outputDirectory === undefined) return null;
  const record = output as Record<string, unknown>;
  const pid =
    typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0
      ? record.pid
      : undefined;
  return {
    outputDirectory,
    ...(pid !== undefined && { pid }),
    extraPaths,
  };
}

export function upsertPendingBackgroundJob(
  existing: readonly PendingBackgroundJob[],
  incoming: PendingBackgroundJob,
): readonly PendingBackgroundJob[] {
  const prev = existing.find((job) => job.outputDirectory === incoming.outputDirectory);
  const filtered = existing.filter((job) => job.outputDirectory !== incoming.outputDirectory);
  const merged: PendingBackgroundJob = {
    outputDirectory: incoming.outputDirectory,
    ...(incoming.pid !== undefined
      ? { pid: incoming.pid }
      : prev?.pid !== undefined
        ? { pid: prev.pid }
        : {}),
    extraPaths: mergeExtraPaths(prev?.extraPaths ?? [], incoming.extraPaths),
  };
  const next = [...filtered, merged];
  return next.length > MAX_PENDING_BACKGROUND_JOBS
    ? next.slice(next.length - MAX_PENDING_BACKGROUND_JOBS)
    : next;
}

export function collectPendingExtraPaths(
  pending: PendingRepositoryReconcile | null,
): readonly string[] {
  if (pending === null) return [];
  let result: readonly string[] = [];
  for (const job of pending.jobs) {
    result = mergeExtraPaths(result, job.extraPaths);
  }
  return result;
}

function isDriveOrSlashRoot(value: string): boolean {
  return value === "/" || /^[A-Za-z]:\/$/u.test(value);
}

function resolveBaseAndRelative(base: string, relative: string): string {
  const normalizedBase = normalizePlatformPath(base);
  const normalizedRel = relative.replaceAll("\\", "/");
  if (isWindowsDrivePath(normalizedBase)) {
    const drive = normalizedBase.slice(0, 2);
    const rest = posix.resolve(normalizedBase.slice(2), normalizedRel);
    return `${drive}${rest}`;
  }
  return posix.resolve(normalizedBase, normalizedRel);
}

function platformDirname(value: string): string {
  if (isWindowsDrivePath(value)) {
    const drive = value.slice(0, 2);
    const rest = posix.dirname(value.slice(2));
    return `${drive}${rest}`;
  }
  return posix.dirname(value);
}

export function normalizeKnownPath(
  targetPath: string,
  state: Pick<RepositorySessionState, "workspaceRoot" | "rawWorkspaceRoot" | "homeDir">,
): string | null {
  const normalizedInput = targetPath.replaceAll("\\", "/");
  if (normalizedInput === "~" || normalizedInput === "$HOME") {
    return state.homeDir === null ? null : normalizePlatformPath(state.homeDir);
  }
  if (normalizedInput.startsWith("~/")) {
    if (state.homeDir === null) return null;
    return resolveBaseAndRelative(state.homeDir, normalizedInput.slice(2));
  }
  if (normalizedInput.startsWith("$HOME/")) {
    if (state.homeDir === null) return null;
    return resolveBaseAndRelative(state.homeDir, normalizedInput.slice("$HOME/".length));
  }
  if (state.workspaceRoot === null) return null;
  const workspaceRoot = normalizePlatformPath(state.workspaceRoot);
  if (normalizedInput.startsWith("/") || isWindowsDrivePath(normalizedInput)) {
    const normalized = normalizePlatformPath(normalizedInput);
    if (state.rawWorkspaceRoot !== null) {
      const raw = normalizePlatformPath(state.rawWorkspaceRoot);
      if (raw !== workspaceRoot) {
        if (normalized === raw) return workspaceRoot;
        const rawPrefix = isDriveOrSlashRoot(raw) ? raw : `${raw}/`;
        if (normalized.startsWith(rawPrefix)) {
          const suffix = normalized.slice(raw.length);
          return suffix.startsWith("/")
            ? `${workspaceRoot}${suffix}`
            : `${workspaceRoot}/${suffix}`;
        }
      }
    }
    return normalized;
  }
  return resolveBaseAndRelative(workspaceRoot, normalizedInput);
}

export function findKnownEnclosingRoot(
  dirPath: string,
  byRoot: Readonly<Record<string, unknown>>,
): string | null {
  let match: string | null = null;
  for (const root of Object.keys(byRoot)) {
    const within = isPathWithinRoot(dirPath, root);
    if (within && (match === null || root.length > match.length)) {
      match = root;
    }
  }
  return match;
}

export function isPathWithinRoot(targetPath: string, root: string): boolean {
  if (isDriveOrSlashRoot(root)) return targetPath.startsWith(root);
  return targetPath === root || targetPath.startsWith(`${root}/`);
}

export function shouldReconcileCommand(
  command: string,
  workingDirectory: string | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
): boolean {
  if (COMMAND_RECONCILE_PATTERN.test(command)) return true;
  if (workingDirectory !== undefined) {
    const resolved = normalizeKnownPath(workingDirectory, state);
    if (resolved === null) return true;
    if (resolved === state.workspaceRoot) return false;
    if (resolved in state.byRoot) return false;
    if (state.checkedDirs.includes(resolved)) return false;
    return true;
  }
  return false;
}

function tokenizeShellCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") escaping = true;
      else if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/[\s;&|<>()]/u.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function isCandidateExternalPath(token: string): boolean {
  if (isWindowsDrivePath(token)) {
    return token.length > 3;
  }
  if (token.startsWith("/")) {
    return (
      token.length > 1 &&
      !token.startsWith("/dev/") &&
      !token.startsWith("/proc/") &&
      !token.startsWith("//")
    );
  }
  return token.startsWith("~/") || token.startsWith("$HOME/");
}

export function extractCommandTargetPaths(
  command: string,
  workingDirectory: string | undefined,
): readonly string[] {
  const paths: string[] = [];
  const push = (candidate: string) => {
    if (paths.length >= MAX_EXTRA_PATHS) return;
    if (candidate.length === 0 || paths.includes(candidate)) return;
    paths.push(candidate);
  };

  if (workingDirectory !== undefined) push(workingDirectory);

  for (const token of tokenizeShellCommand(command)) {
    if (paths.length >= MAX_EXTRA_PATHS) break;
    if (isCandidateExternalPath(token)) {
      push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq !== -1) {
      const value = token.slice(eq + 1);
      if (isCandidateExternalPath(value)) push(value);
    }
  }

  return paths;
}

export function mergeExtraPaths(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const result: string[] = [];
  for (const item of [...first, ...second]) {
    if (result.length >= MAX_EXTRA_PATHS) break;
    if (item.length > 0 && !result.includes(item)) result.push(item);
  }
  return result;
}

export function classifySettledCall(
  observed: CallObservation | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
  syncAfter: readonly ToolDefinition<any, any>[],
): SettledCallAction {
  if (observed?.kind !== "tool" || observed.state !== "completed") {
    return { kind: "none" };
  }

  for (const tool of syncAfter) {
    if (toolResultFrom(observed, tool) !== undefined) {
      return { kind: "reconcile", extraPaths: [] };
    }
  }

  if (FILE_TOOLS.has(observed.name)) {
    const targetPath =
      readStringField(observed.output, "path") ??
      readStringField(observed.input, "filePath") ??
      readStringField(observed.input, "path");
    if (targetPath === undefined) return { kind: "none" };
    return {
      kind: "file",
      targetPath,
      isDirectory: DIRECTORY_TOOLS.has(observed.name),
    };
  }

  const command = readStringField(observed.input, "command");
  if (observed.name === "bash" || command !== undefined) {
    const workingDirectory = readStringField(observed.input, "workingDirectory");
    if (command !== undefined && shouldReconcileCommand(command, workingDirectory, state)) {
      return {
        kind: "reconcile",
        extraPaths: extractCommandTargetPaths(command, workingDirectory),
      };
    }
    return { kind: "none" };
  }

  return { kind: "none" };
}

export function hasUncheckedFileAncestors(
  targetPath: string,
  isDirectory: boolean,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
  scopedInstructions: boolean,
): boolean {
  if (state.workspaceRoot === null) return true;
  const resolved = normalizeKnownPath(targetPath, state);
  if (resolved === null) return true;
  const targetDir = isDirectory ? resolved : platformDirname(resolved);
  const enclosingRoot = findKnownEnclosingRoot(targetDir, state.byRoot);

  if (enclosingRoot !== null) {
    if (!scopedInstructions) return false;
    const ancestors = computeAncestorDirs(enclosingRoot, targetDir);
    if (ancestors.length === 0) return false;
    const checked = new Set(state.checkedDirs);
    return ancestors.some((dir) => !checked.has(dir));
  }

  if (!isPathWithinRoot(targetDir, state.workspaceRoot)) {
    return !state.checkedDirs.includes(targetDir);
  }

  if (!scopedInstructions) {
    return targetDir !== state.workspaceRoot && !state.checkedDirs.includes(targetDir);
  }

  const ancestors = computeAncestorDirs(state.workspaceRoot, targetDir);
  if (ancestors.length === 0) return false;
  const checked = new Set(state.checkedDirs);
  return ancestors.some((dir) => !checked.has(dir));
}

async function readMatchingRuleFiles(
  sandbox: RepositorySandbox,
  repo: DiscoveredRepository,
  resolved: ResolvedRepositoriesConfig,
): Promise<readonly RepositoryInstructionFile[]> {
  const specs: RepositoryInstructionSpec[] = [];
  for (const rule of resolved.rules) {
    if (!matchesRepositoryRule(repo, rule.match)) continue;
    if (rule.files !== undefined) specs.push(...rule.files);
  }
  if (specs.length === 0) return [];
  const loaded = await readRepositorySpecFiles(sandbox, repo.root, specs, {
    maxFileBytes: resolved.maxFileBytes,
  });
  const defaultPaths = new Set(repo.instructions.map((file) => file.relativePath));
  const seen = new Set<string>();
  const unique: RepositoryInstructionFile[] = [];
  for (const file of loaded) {
    if (defaultPaths.has(file.relativePath) || seen.has(file.relativePath)) continue;
    seen.add(file.relativePath);
    unique.push(file);
  }
  return unique;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidSkillDefinition(value: unknown): value is SkillDefinition {
  return (
    isRecord(value) && typeof value.description === "string" && typeof value.content === "string"
  );
}

function computeRemainingPending(
  current: PendingRepositoryReconcile | null,
  finishedJobDirs: readonly string[],
  clearAll: boolean,
): PendingRepositoryReconcile | null {
  if (current === null) return null;
  if (clearAll) return null;
  if (finishedJobDirs.length === 0) return current;
  const finished = new Set(finishedJobDirs);
  const remaining = current.jobs.filter((job) => !finished.has(job.outputDirectory));
  return remaining.length > 0 ? { jobs: remaining } : null;
}

export async function onboardRepository(
  sandbox: RuntimeSandboxSession,
  repo: DiscoveredRepository,
  resolved: ResolvedRepositoriesConfig,
  ruleCtx: RepositoryRuleContext,
): Promise<RecordedRepository> {
  let ruleFiles: readonly RepositoryInstructionFile[] = [];
  try {
    ruleFiles = await readMatchingRuleFiles(sandbox, repo, resolved);
  } catch {}
  const entered: EnteredRepository = {
    ...repo,
    readFile: (relativePath: string) =>
      readRepositoryFile(sandbox, repo.root, relativePath, {
        maxFileBytes: resolved.maxFileBytes,
      }),
  };

  const ruleInstructions: string[] = [];
  const ruleSkills: Record<string, SerializedSkillDefinition> = {};

  for (const rule of resolved.rules) {
    if (!matchesRepositoryRule(repo, rule.match)) continue;
    if (rule.onEnter === undefined) continue;
    let contribution: Awaited<ReturnType<NonNullable<typeof rule.onEnter>>>;
    try {
      contribution = await rule.onEnter(entered, ruleCtx);
    } catch (error) {
      console.warn(
        `eve-code repository rule onEnter failed for ${repo.root}: ${errorMessage(error)}`,
      );
      continue;
    }
    if (!isRecord(contribution)) continue;
    if (contribution.instructions !== undefined) {
      try {
        const items =
          typeof contribution.instructions === "string"
            ? [contribution.instructions]
            : Array.isArray(contribution.instructions)
              ? contribution.instructions
              : [];
        for (const item of items) {
          if (typeof item !== "string") continue;
          const trimmed = item.trim();
          if (trimmed.length > 0) ruleInstructions.push(trimmed);
        }
      } catch (error) {
        console.warn(
          `eve-code skipped invalid repository rule instructions for ${repo.root}: ${errorMessage(error)}`,
        );
      }
    }
    if (isRecord(contribution.skills)) {
      for (const [name, skill] of Object.entries(contribution.skills)) {
        if (!isValidRepositorySkillName(name)) {
          console.warn(
            `eve-code skipped invalid repository skill name ${JSON.stringify(name)} for ${repo.root}.`,
          );
          continue;
        }
        if (name in ruleSkills) continue;
        if (!isValidSkillDefinition(skill)) {
          console.warn(
            `eve-code skipped malformed repository skill ${JSON.stringify(name)} for ${repo.root}: skill must have string description and content.`,
          );
          continue;
        }
        try {
          ruleSkills[name] = serializeSkill(skill);
        } catch (error) {
          console.warn(
            `eve-code skipped malformed repository skill ${JSON.stringify(name)} for ${repo.root}: ${errorMessage(error)}`,
          );
        }
      }
    }
  }

  return {
    root: repo.root,
    slug: repo.slug,
    remote: repo.remote,
    head: repo.head,
    branch: repo.branch,
    sparse: repo.sparse,
    instructions: repo.instructions,
    ruleFiles,
    ruleInstructions,
    ruleSkills,
    enteredAtHead: repo.head,
  };
}

export async function reconcileWorkspace(
  sandbox: RuntimeSandboxSession,
  resolved: ResolvedRepositoriesConfig,
  ruleCtx: RepositoryRuleContext,
  options: {
    readonly turnId?: string | null;
    readonly extraPaths?: readonly string[];
    readonly pendingJobs?: readonly PendingBackgroundJob[];
    readonly clearAllPendingJobs?: boolean;
  } = {},
): Promise<void> {
  const rawWorkspaceRoot = sandbox.resolvePath(".");
  const snapshot = repoState.get();
  let discovery: Awaited<ReturnType<typeof discoverWorkspace>>;
  try {
    discovery = await discoverWorkspace(sandbox, {
      roots: resolved.roots,
      instructions: resolved.instructions,
      maxFileBytes: resolved.maxFileBytes,
      includeWorkspaceInstructions: true,
      extraPaths: options.extraPaths,
      existingRoots: Object.keys(snapshot.byRoot),
      pendingJobs: options.pendingJobs,
    });
  } catch {
    return;
  }

  const discoveredRepos = new Map<string, DiscoveredRepository>();
  for (const repo of discovery.repositories) {
    discoveredRepos.set(repo.root, repo);
  }

  const deletedRoots = Object.keys(snapshot.byRoot).filter((root) => !discoveredRepos.has(root));
  const headChangedRoots: string[] = [];
  const upsertedRepos: Record<string, RecordedRepository> = {};
  let changed =
    deletedRoots.length > 0 ||
    snapshot.workspaceRoot !== discovery.workspaceRoot ||
    snapshot.rawWorkspaceRoot !== rawWorkspaceRoot ||
    (discovery.homeDir !== null && snapshot.homeDir !== discovery.homeDir);

  for (const repo of discoveredRepos.values()) {
    const existing = snapshot.byRoot[repo.root];
    if (existing === undefined) {
      upsertedRepos[repo.root] = await onboardRepository(sandbox, repo, resolved, ruleCtx);
      changed = true;
      continue;
    }

    const headChanged = existing.head !== repo.head;
    const hasRuleFileSpecs = resolved.rules.some(
      (rule) => matchesRepositoryRule(repo, rule.match) && (rule.files?.length ?? 0) > 0,
    );
    let ruleFiles: readonly RepositoryInstructionFile[] = hasRuleFileSpecs
      ? existing.ruleFiles
      : [];
    if (hasRuleFileSpecs) {
      try {
        ruleFiles = await readMatchingRuleFiles(sandbox, repo, resolved);
      } catch {}
    }

    const metadataChanged =
      headChanged ||
      existing.slug !== repo.slug ||
      existing.remote !== repo.remote ||
      existing.branch !== repo.branch ||
      existing.sparse !== repo.sparse ||
      JSON.stringify(existing.instructions) !== JSON.stringify(repo.instructions) ||
      JSON.stringify(existing.ruleFiles) !== JSON.stringify(ruleFiles);

    if (headChanged) {
      headChangedRoots.push(repo.root);
    }

    if (metadataChanged) {
      upsertedRepos[repo.root] = {
        ...existing,
        slug: repo.slug,
        remote: repo.remote,
        head: repo.head,
        branch: repo.branch,
        sparse: repo.sparse,
        instructions: repo.instructions,
        ruleFiles,
      };
      changed = true;
    }
  }

  const nextSyncedTurnId = options.turnId !== undefined ? options.turnId : snapshot.syncedTurnId;
  if (nextSyncedTurnId !== snapshot.syncedTurnId) {
    changed = true;
  }
  const finishedJobDirs = discovery.finishedJobDirs;
  const finishedSet = new Set(finishedJobDirs);
  const pendingChanged =
    snapshot.pendingReconcile !== null &&
    (options.clearAllPendingJobs === true ||
      snapshot.pendingReconcile.jobs.some((job) => finishedSet.has(job.outputDirectory)));
  if (pendingChanged) {
    changed = true;
  }

  const previewByRoot: Record<string, RecordedRepository> = { ...snapshot.byRoot };
  for (const deleted of deletedRoots) delete previewByRoot[deleted];
  Object.assign(previewByRoot, upsertedRepos);
  const workspaceCovered =
    findKnownEnclosingRoot(discovery.workspaceRoot, previewByRoot) !== null ||
    discovery.workspaceRoot in snapshot.scopes;
  const previewWorkspaceInstruction = workspaceCovered ? [] : discovery.workspaceInstructions;
  if (
    JSON.stringify(snapshot.workspaceInstruction) !== JSON.stringify(previewWorkspaceInstruction)
  ) {
    changed = true;
  }

  if (!changed) return;

  repoState.update((latest) => {
    const nextByRoot: Record<string, RecordedRepository> = { ...latest.byRoot };
    for (const deleted of deletedRoots) delete nextByRoot[deleted];
    Object.assign(nextByRoot, upsertedRepos);

    const invalidatedRoots = new Set([...deletedRoots, ...headChangedRoots]);
    const nextScopes: Record<string, RecordedScope> = {};
    for (const [dir, scope] of Object.entries(latest.scopes)) {
      if (scope.repoRoot !== null && invalidatedRoots.has(scope.repoRoot)) continue;
      nextScopes[dir] = scope;
    }

    let nextCheckedDirs = latest.checkedDirs;
    for (const root of invalidatedRoots) {
      nextCheckedDirs = invalidateRepoCheckedDirs(nextCheckedDirs, root);
    }

    const latestWorkspaceCovered =
      findKnownEnclosingRoot(discovery.workspaceRoot, nextByRoot) !== null ||
      discovery.workspaceRoot in nextScopes;
    const nextWorkspaceInstruction = latestWorkspaceCovered ? [] : discovery.workspaceInstructions;

    return {
      ...latest,
      workspaceRoot: discovery.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: discovery.homeDir ?? latest.homeDir,
      workspaceInstruction: nextWorkspaceInstruction,
      byRoot: nextByRoot,
      scopes: nextScopes,
      checkedDirs: nextCheckedDirs,
      syncedTurnId: options.turnId !== undefined ? options.turnId : latest.syncedTurnId,
      pendingReconcile: computeRemainingPending(
        latest.pendingReconcile,
        finishedJobDirs,
        options.clearAllPendingJobs === true,
      ),
      revision: latest.revision + 1,
    };
  });
}

export async function reconcileTouchedFile(
  sandbox: RuntimeSandboxSession,
  targetPath: string,
  resolved: ResolvedRepositoriesConfig,
  ruleCtx: RepositoryRuleContext,
): Promise<void> {
  const current = repoState.get();
  const rawWorkspaceRoot = sandbox.resolvePath(".");
  let probe: Awaited<ReturnType<typeof readScopedDirectoryInstructions>>;
  try {
    probe = await readScopedDirectoryInstructions(sandbox, {
      targetPath,
      checkedDirs: new Set(current.checkedDirs),
      knownRepoRoots: new Set(Object.keys(current.byRoot)),
      instructions: resolved.instructions,
      maxFileBytes: resolved.maxFileBytes,
      loadScoped: resolved.scopedInstructions,
    });
  } catch {
    return;
  }

  let onboarded: RecordedRepository | null = null;
  if (probe.enclosingRepo !== null && !(probe.enclosingRepo.root in current.byRoot)) {
    onboarded = await onboardRepository(sandbox, probe.enclosingRepo, resolved, ruleCtx);
  }

  const scopeHitsByDir = new Map(probe.scopes.map((hit) => [hit.dir, hit.files]));
  const removedScopeDirs = probe.checkedDirs.filter(
    (dir) => !scopeHitsByDir.has(dir) && dir in current.scopes,
  );
  const scopesChanged = probe.scopes.length > 0 || removedScopeDirs.length > 0;
  const checkedChanged = probe.checkedDirs.length > 0;
  const workspaceChanged =
    current.workspaceRoot !== probe.workspaceRoot ||
    current.rawWorkspaceRoot !== rawWorkspaceRoot ||
    (probe.homeDir !== null && current.homeDir !== probe.homeDir);

  if (onboarded === null && !scopesChanged && !checkedChanged && !workspaceChanged) {
    return;
  }

  repoState.update((latest) => {
    const nextByRoot: Record<string, RecordedRepository> = { ...latest.byRoot };
    if (onboarded !== null) nextByRoot[onboarded.root] = onboarded;

    const enclosingRoot = probe.enclosingRepoRoot;
    const enclosingSlug = enclosingRoot !== null ? (nextByRoot[enclosingRoot]?.slug ?? null) : null;

    const nextScopes: Record<string, RecordedScope> = { ...latest.scopes };
    for (const dir of probe.checkedDirs) {
      const files = scopeHitsByDir.get(dir);
      if (files !== undefined) {
        nextScopes[dir] = {
          dir,
          repoRoot: enclosingRoot,
          repoSlug: enclosingSlug,
          files,
        };
      } else if (dir in nextScopes) {
        delete nextScopes[dir];
      }
    }

    const workspaceCovered =
      findKnownEnclosingRoot(probe.workspaceRoot, nextByRoot) !== null ||
      probe.workspaceRoot in nextScopes;

    return {
      ...latest,
      workspaceRoot: probe.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: probe.homeDir ?? latest.homeDir,
      workspaceInstruction: workspaceCovered ? [] : latest.workspaceInstruction,
      byRoot: nextByRoot,
      scopes: nextScopes,
      checkedDirs: appendCheckedDirs(latest.checkedDirs, probe.checkedDirs),
      revision: onboarded !== null || scopesChanged ? latest.revision + 1 : latest.revision,
    };
  });
}

export async function discoverWorkspaceReadOnly(
  sandbox: RepositorySandbox,
  resolved: ResolvedRepositoriesConfig,
): Promise<Pick<RepositorySessionState, "workspaceRoot" | "workspaceInstruction" | "byRoot">> {
  const discovery = await discoverWorkspace(sandbox, {
    roots: resolved.roots,
    instructions: resolved.instructions,
    maxFileBytes: resolved.maxFileBytes,
    includeWorkspaceInstructions: true,
  });

  const byRoot: Record<string, RecordedRepository> = {};
  for (const repo of discovery.repositories) {
    let ruleFiles: readonly RepositoryInstructionFile[] = [];
    try {
      ruleFiles = await readMatchingRuleFiles(sandbox, repo, resolved);
    } catch {}
    byRoot[repo.root] = {
      root: repo.root,
      slug: repo.slug,
      remote: repo.remote,
      head: repo.head,
      branch: repo.branch,
      sparse: repo.sparse,
      instructions: repo.instructions,
      ruleFiles,
      ruleInstructions: [],
      ruleSkills: {},
      enteredAtHead: repo.head,
    };
  }

  return {
    workspaceRoot: discovery.workspaceRoot,
    workspaceInstruction: discovery.workspaceInstructions,
    byRoot,
  };
}
