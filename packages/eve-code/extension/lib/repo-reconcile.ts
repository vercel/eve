import { posix } from "node:path";
import type { CallObservation } from "eve/events";
import type { RuntimeSandboxSession } from "eve/sandbox";
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
  repoState,
  type RecordedRepository,
  type RecordedScope,
  type RepositorySessionState,
} from "./repo-state.ts";
import {
  appendOverflowPaths,
  computeAncestorDirs,
  discoverWorkspace,
  isPathWithinRoot,
  matchesRepositoryRule,
  MAX_DISCOVERED_REPOSITORIES,
  MAX_OVERFLOW_PATHS,
  readRepositoryFile,
  readRepositorySpecFiles,
  readScopedDirectoryInstructions,
  type RepositorySandbox,
  type ResolvedRepositoriesConfig,
} from "./repositories.ts";

const FILE_TOOLS = new Set(["read_file", "edit_file", "write_file", "glob", "grep"]);
const DIRECTORY_TOOLS = new Set(["glob", "grep"]);
const MAX_EXTRA_PATHS = 8;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const REDIR_TOKEN = /^(?:\d+|&)?[<>]/u;
const STANDALONE_REDIR = /^(?:\d+|&)?(?:>>?|<<?[-<]?|<>|>[|&]|<&)$/u;
const SHELL_PREFIXES = new Set("if then elif else do done fi while until case in ! {".split(" "));
const SHELL_WRAPPERS = new Set("env sudo command exec nohup time".split(" "));
const GIT_VALUE_FLAGS = new Set(
  "-C -c --git-dir --work-tree --namespace --super-prefix --config-env --attr-source --exec-path".split(
    " ",
  ),
);
const GIT_RECONCILE_SUBCOMMANDS = new Set(
  "clone checkout switch fetch pull worktree submodule sparse-checkout reset init merge rebase remote cherry-pick revert".split(
    " ",
  ),
);
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

export type SettledCallAction =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly targetPath: string; readonly isDirectory: boolean }
  | { readonly kind: "reconcile"; readonly extraPaths: readonly string[] };

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

export function normalizeKnownPath(
  targetPath: string,
  state: Pick<RepositorySessionState, "workspaceRoot" | "rawWorkspaceRoot" | "homeDir">,
): string | null {
  if (targetPath === "~" || targetPath === "$HOME") {
    return state.homeDir === null ? null : posix.resolve("/", state.homeDir);
  }
  if (targetPath.startsWith("~/")) {
    return state.homeDir === null ? null : posix.resolve(state.homeDir, targetPath.slice(2));
  }
  if (targetPath.startsWith("$HOME/")) {
    return state.homeDir === null ? null : posix.resolve(state.homeDir, targetPath.slice(6));
  }
  if (state.workspaceRoot === null) return null;
  const workspaceRoot = posix.resolve("/", state.workspaceRoot);
  if (!targetPath.startsWith("/")) return posix.resolve(workspaceRoot, targetPath);
  const normalized = posix.resolve("/", targetPath);
  if (state.rawWorkspaceRoot !== null) {
    const raw = posix.resolve("/", state.rawWorkspaceRoot);
    if (raw !== workspaceRoot) {
      if (normalized === raw) return workspaceRoot;
      if (normalized.startsWith(raw === "/" ? "/" : `${raw}/`)) {
        return `${workspaceRoot}${normalized.slice(raw.length)}`;
      }
    }
  }
  return normalized;
}

function findKnownEnclosingRoot(
  dirPath: string,
  byRoot: Readonly<Record<string, unknown>>,
): string | null {
  let match: string | null = null;
  for (const root of Object.keys(byRoot)) {
    if (isPathWithinRoot(dirPath, root) && (match === null || root.length > match.length)) {
      match = root;
    }
  }
  return match;
}

export function isWorkspaceCovered(
  workspaceRoot: string | null,
  byRoot: Readonly<Record<string, unknown>>,
  scopes: Readonly<Record<string, unknown>>,
): boolean {
  return (
    workspaceRoot !== null &&
    (findKnownEnclosingRoot(workspaceRoot, byRoot) !== null || workspaceRoot in scopes)
  );
}

function splitShellSegments(command: string): readonly (readonly string[])[] {
  const segments: string[][] = [];
  let seg: string[] = [];
  let tok = "";
  let quote: "'" | '"' | null = null;
  let esc = false;
  const pushTok = () => {
    if (tok.length > 0) {
      seg.push(tok);
      tok = "";
    }
  };
  const pushSeg = () => {
    pushTok();
    if (seg.length > 0) {
      segments.push(seg);
      seg = [];
    }
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (esc) {
      tok += ch;
      esc = false;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      else tok += ch;
    } else if (quote === '"') {
      if (ch === "\\") esc = true;
      else if (ch === '"') quote = null;
      else tok += ch;
    } else if (ch === "\\") {
      esc = true;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#" && tok.length === 0) {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
    } else if (";\n|()".includes(ch)) {
      pushSeg();
      if (ch === "|" && (command[i + 1] === "|" || command[i + 1] === "&")) i += 1;
    } else if (ch === "&" && command[i + 1] !== ">" && !tok.endsWith(">") && !tok.endsWith("<")) {
      if (command[i + 1] === "&") i += 1;
      pushSeg();
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      pushTok();
    } else {
      tok += ch;
    }
  }
  pushSeg();
  return segments;
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

function isMutatingSegment(segment: readonly string[]): boolean {
  let i = 0;
  while (i < segment.length) {
    const t = segment[i]!;
    if (STANDALONE_REDIR.test(t)) i += 2;
    else if (REDIR_TOKEN.test(t) || ENV_ASSIGNMENT.test(t) || SHELL_PREFIXES.has(t)) i += 1;
    else if (SHELL_WRAPPERS.has(basename(t))) {
      i += 1;
      while (i < segment.length && segment[i]!.startsWith("-") && segment[i] !== "--") i += 1;
      if (segment[i] === "--") i += 1;
    } else break;
  }
  if (i >= segment.length) return false;
  const exe = basename(segment[i]!);
  if (exe === "tar" || exe === "unzip") return true;
  if (exe === "git") {
    for (let j = i + 1; j < segment.length; j += 1) {
      const arg = segment[j]!;
      if (arg === "--") return false;
      if (arg.startsWith("-")) {
        if (GIT_VALUE_FLAGS.has(arg)) j += 1;
      } else return GIT_RECONCILE_SUBCOMMANDS.has(arg);
    }
    return false;
  }
  if (exe === "gh") {
    const pos: string[] = [];
    let hasClone = false;
    for (let j = i + 1; j < segment.length && segment[j] !== "--"; j += 1) {
      const arg = segment[j]!;
      if (arg.startsWith("-")) {
        if (arg === "--clone" || arg === "--clone=true" || arg === "-c") hasClone = true;
        if (GH_VALUE_FLAGS.has(arg)) j += 1;
      } else if (pos.length < 2) pos.push(arg);
    }
    return (
      (pos[0] === "pr" && pos[1] === "checkout") ||
      (pos[0] === "repo" &&
        (pos[1] === "clone" || ((pos[1] === "fork" || pos[1] === "create") && hasClone)))
    );
  }
  return false;
}

function shouldReconcileSegments(
  segments: readonly (readonly string[])[],
  workingDirectory: string | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
): boolean {
  if (segments.some(isMutatingSegment)) return true;
  if (workingDirectory === undefined) return false;
  const resolved = normalizeKnownPath(workingDirectory, state);
  return (
    resolved === null ||
    (resolved !== state.workspaceRoot &&
      !(resolved in state.byRoot) &&
      !state.checkedDirs.includes(resolved))
  );
}

export function shouldReconcileCommand(
  command: string,
  workingDirectory: string | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
): boolean {
  return shouldReconcileSegments(splitShellSegments(command), workingDirectory, state);
}

function isCandidateExternalPath(token: string): boolean {
  return token.startsWith("/")
    ? token.length > 1 &&
        !token.startsWith("/dev/") &&
        !token.startsWith("/proc/") &&
        !token.startsWith("//")
    : token.startsWith("~/") || token.startsWith("$HOME/");
}

function extractSegmentTargetPaths(
  segments: readonly (readonly string[])[],
  workingDirectory: string | undefined,
): readonly string[] {
  const paths: string[] = [];
  const push = (candidate: string) => {
    if (paths.length < MAX_EXTRA_PATHS && candidate.length > 0 && !paths.includes(candidate)) {
      paths.push(candidate);
    }
  };
  if (workingDirectory !== undefined) push(workingDirectory);
  for (const segment of segments) {
    for (const token of segment) {
      if (paths.length >= MAX_EXTRA_PATHS) return paths;
      if (isCandidateExternalPath(token)) push(token);
      else {
        const eq = token.indexOf("=");
        if (eq !== -1 && isCandidateExternalPath(token.slice(eq + 1))) push(token.slice(eq + 1));
      }
    }
  }
  return paths;
}

export function extractCommandTargetPaths(
  command: string,
  workingDirectory: string | undefined,
): readonly string[] {
  return extractSegmentTargetPaths(splitShellSegments(command), workingDirectory);
}

export function classifySettledCall(
  observed: CallObservation | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
  syncAfter: readonly ToolDefinition<any, any>[],
): SettledCallAction {
  if (observed?.kind !== "tool" || observed.state !== "completed") return { kind: "none" };
  for (const tool of syncAfter) {
    if (toolResultFrom(observed, tool) !== undefined) return { kind: "reconcile", extraPaths: [] };
  }
  if (FILE_TOOLS.has(observed.name)) {
    const targetPath =
      readStringField(observed.output, "path") ??
      readStringField(observed.input, "filePath") ??
      readStringField(observed.input, "path");
    return targetPath === undefined
      ? { kind: "none" }
      : { kind: "file", targetPath, isDirectory: DIRECTORY_TOOLS.has(observed.name) };
  }
  const command = readStringField(observed.input, "command");
  if (command !== undefined) {
    const workingDirectory = readStringField(observed.input, "workingDirectory");
    const segments = splitShellSegments(command);
    if (shouldReconcileSegments(segments, workingDirectory, state)) {
      return {
        kind: "reconcile",
        extraPaths: extractSegmentTargetPaths(segments, workingDirectory),
      };
    }
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
  const targetDir = isDirectory ? resolved : posix.dirname(resolved);
  const enclosingRoot = findKnownEnclosingRoot(targetDir, state.byRoot);
  if (enclosingRoot !== null) {
    if (!scopedInstructions) return false;
    const checked = new Set(state.checkedDirs);
    return computeAncestorDirs(enclosingRoot, targetDir).some((dir) => !checked.has(dir));
  }
  if (!isPathWithinRoot(targetDir, state.workspaceRoot)) {
    return !state.checkedDirs.includes(targetDir);
  }
  if (!scopedInstructions) {
    return targetDir !== state.workspaceRoot && !state.checkedDirs.includes(targetDir);
  }
  const checked = new Set(state.checkedDirs);
  return computeAncestorDirs(state.workspaceRoot, targetDir).some((dir) => !checked.has(dir));
}

function capRecordedRepositories(byRoot: Readonly<Record<string, RecordedRepository>>) {
  const entries = Object.entries(byRoot);
  if (entries.length <= MAX_DISCOVERED_REPOSITORIES) {
    return { byRoot: { ...byRoot }, overflowRoots: [] as string[] };
  }
  return {
    byRoot: Object.fromEntries(entries.slice(0, MAX_DISCOVERED_REPOSITORIES)),
    overflowRoots: entries.slice(MAX_DISCOVERED_REPOSITORIES).map(([root]) => root),
  };
}

async function loadMatchingRuleFiles(
  sandbox: RepositorySandbox,
  repo: DiscoveredRepository,
  resolved: ResolvedRepositoriesConfig,
  fallbackFiles: readonly RepositoryInstructionFile[] = [],
): Promise<{
  readonly files: readonly RepositoryInstructionFile[];
  readonly overflowPaths: readonly string[];
}> {
  const specs: RepositoryInstructionSpec[] = [];
  for (const rule of resolved.rules) {
    if (matchesRepositoryRule(repo, rule.match) && rule.files !== undefined) {
      specs.push(...rule.files);
    }
  }
  if (specs.length === 0) return { files: [], overflowPaths: [] };
  try {
    const loaded = await readRepositorySpecFiles(sandbox, repo.root, specs, {
      maxFileBytes: resolved.maxFileBytes,
      maxTotalBytes: resolved.maxTotalBytes,
      sparse: repo.sparse,
    });
    const seen = new Set(repo.instructions.map((f) => f.relativePath));
    const files: RepositoryInstructionFile[] = [];
    for (const file of loaded.files) {
      if (seen.has(file.relativePath)) continue;
      seen.add(file.relativePath);
      files.push(file);
    }
    return { files, overflowPaths: loaded.overflowPaths };
  } catch {
    return { files: fallbackFiles, overflowPaths: [] };
  }
}

function commitRepoState(
  snapshot: RepositorySessionState,
  buildNext: (base: RepositorySessionState) => RepositorySessionState,
): void {
  if (JSON.stringify(buildNext(snapshot)) === JSON.stringify(snapshot)) return;
  repoState.update(buildNext);
}

export async function onboardRepository(
  sandbox: RuntimeSandboxSession,
  repo: DiscoveredRepository,
  resolved: ResolvedRepositoriesConfig,
  ruleCtx: RepositoryRuleContext,
): Promise<{ readonly repo: RecordedRepository; readonly overflowPaths: readonly string[] }> {
  const { files: ruleFiles, overflowPaths } = await loadMatchingRuleFiles(sandbox, repo, resolved);

  const entered: EnteredRepository = {
    ...repo,
    readFile: (relativePath) =>
      readRepositoryFile(sandbox, repo.root, relativePath, {
        maxFileBytes: resolved.maxFileBytes,
      }),
  };

  const ruleInstructions: string[] = [];
  for (const rule of resolved.rules) {
    if (!matchesRepositoryRule(repo, rule.match) || rule.onEnter === undefined) continue;
    let contribution: Awaited<ReturnType<NonNullable<typeof rule.onEnter>>>;
    try {
      contribution = await rule.onEnter(entered, ruleCtx);
    } catch (error) {
      console.warn(
        `eve-code repository rule onEnter failed for ${repo.root}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!isRecord(contribution) || contribution.instructions === undefined) continue;
    const items =
      typeof contribution.instructions === "string"
        ? [contribution.instructions]
        : Array.isArray(contribution.instructions)
          ? contribution.instructions
          : [];
    for (const item of items) {
      if (typeof item === "string" && item.trim().length > 0) ruleInstructions.push(item.trim());
    }
  }

  return {
    repo: { ...repo, ruleFiles, ruleInstructions },
    overflowPaths,
  };
}

export async function reconcileWorkspace(
  sandbox: RuntimeSandboxSession,
  resolved: ResolvedRepositoriesConfig,
  ruleCtx: RepositoryRuleContext,
  options: { readonly turnId?: string | null; readonly extraPaths?: readonly string[] } = {},
): Promise<void> {
  const rawWorkspaceRoot = sandbox.resolvePath(".");
  const snapshot = repoState.get();

  let discovery: Awaited<ReturnType<typeof discoverWorkspace>>;
  try {
    discovery = await discoverWorkspace(sandbox, {
      roots: resolved.roots,
      instructions: resolved.instructions,
      maxFileBytes: resolved.maxFileBytes,
      maxTotalBytes: resolved.maxTotalBytes,
      includeWorkspaceInstructions: true,
      extraPaths: options.extraPaths,
      existingRoots: Object.keys(snapshot.byRoot),
    });
  } catch {
    return;
  }

  const discoveredRepos = new Map(discovery.repositories.map((repo) => [repo.root, repo]));
  const extraOverflowPaths: string[] = [];
  const deletedRoots = Object.keys(snapshot.byRoot).filter((root) => !discoveredRepos.has(root));
  const headChangedRoots: string[] = [];
  const upsertedRepos: Record<string, RecordedRepository> = {};

  for (const repo of discoveredRepos.values()) {
    const existing = snapshot.byRoot[repo.root];
    if (existing === undefined) {
      const onboarded = await onboardRepository(sandbox, repo, resolved, ruleCtx);
      upsertedRepos[repo.root] = onboarded.repo;
      extraOverflowPaths.push(...onboarded.overflowPaths);
      continue;
    }

    const matched = await loadMatchingRuleFiles(sandbox, repo, resolved, existing.ruleFiles);
    extraOverflowPaths.push(...matched.overflowPaths);
    if (existing.head !== repo.head) headChangedRoots.push(repo.root);
    upsertedRepos[repo.root] = { ...existing, ...repo, ruleFiles: matched.files };
  }

  commitRepoState(snapshot, (base) => {
    const nextUnbounded: Record<string, RecordedRepository> = { ...base.byRoot };
    for (const deleted of deletedRoots) delete nextUnbounded[deleted];
    Object.assign(nextUnbounded, upsertedRepos);
    const capped = capRecordedRepositories(nextUnbounded);
    const invalidated = new Set([...deletedRoots, ...headChangedRoots, ...capped.overflowRoots]);
    const nextScopes: Record<string, RecordedScope> = {};
    for (const [dir, scope] of Object.entries(base.scopes)) {
      if (scope.repoRoot !== null && invalidated.has(scope.repoRoot)) continue;
      nextScopes[dir] = scope;
    }
    let nextCheckedDirs = base.checkedDirs;
    for (const root of invalidated) {
      nextCheckedDirs = invalidateRepoCheckedDirs(nextCheckedDirs, root);
    }
    const wsCovered = isWorkspaceCovered(discovery.workspaceRoot, capped.byRoot, nextScopes);
    return {
      ...base,
      workspaceRoot: discovery.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: discovery.homeDir ?? base.homeDir,
      workspaceInstruction: wsCovered ? [] : discovery.workspaceInstructions,
      byRoot: capped.byRoot,
      scopes: nextScopes,
      checkedDirs: nextCheckedDirs,
      overflowPaths: appendOverflowPaths(
        [],
        [...discovery.overflowPaths, ...extraOverflowPaths, ...capped.overflowRoots],
        MAX_OVERFLOW_PATHS,
      ),
      syncedTurnId: options.turnId !== undefined ? options.turnId : base.syncedTurnId,
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
  const sparseRepoRoots = new Set(
    Object.values(current.byRoot)
      .filter((r) => r.sparse)
      .map((r) => r.root),
  );
  let probe: Awaited<ReturnType<typeof readScopedDirectoryInstructions>>;
  try {
    probe = await readScopedDirectoryInstructions(sandbox, {
      targetPath,
      checkedDirs: new Set(current.checkedDirs),
      knownRepoRoots: new Set(Object.keys(current.byRoot)),
      sparseRepoRoots,
      instructions: resolved.instructions,
      maxFileBytes: resolved.maxFileBytes,
      maxTotalBytes: resolved.maxTotalBytes,
      loadScoped: resolved.scopedInstructions,
    });
  } catch {
    return;
  }

  let onboarded: RecordedRepository | null = null;
  const extraOverflow: string[] = [...probe.overflowPaths];
  if (probe.enclosingRepo !== null && !(probe.enclosingRepo.root in current.byRoot)) {
    if (Object.keys(current.byRoot).length < MAX_DISCOVERED_REPOSITORIES) {
      const entered = await onboardRepository(sandbox, probe.enclosingRepo, resolved, ruleCtx);
      onboarded = entered.repo;
      extraOverflow.push(...entered.overflowPaths);
    } else {
      extraOverflow.push(probe.enclosingRepo.root);
    }
  }

  const scopeHits = new Map(probe.scopes.map((hit) => [hit.dir, hit.files]));
  commitRepoState(current, (base) => {
    const nextByRoot: Record<string, RecordedRepository> = { ...base.byRoot };
    const skipped = [...extraOverflow];
    if (onboarded !== null) {
      if (
        onboarded.root in nextByRoot ||
        Object.keys(nextByRoot).length < MAX_DISCOVERED_REPOSITORIES
      ) {
        nextByRoot[onboarded.root] = onboarded;
      } else {
        skipped.push(onboarded.root);
      }
    }
    const enclosingRoot = probe.enclosingRepoRoot;
    const enclosingSlug = enclosingRoot !== null ? (nextByRoot[enclosingRoot]?.slug ?? null) : null;
    const nextScopes: Record<string, RecordedScope> = { ...base.scopes };
    for (const dir of probe.checkedDirs) {
      const files = scopeHits.get(dir);
      if (files !== undefined) {
        nextScopes[dir] = { dir, repoRoot: enclosingRoot, repoSlug: enclosingSlug, files };
      } else if (dir in nextScopes) {
        delete nextScopes[dir];
      }
    }
    const wsCovered = isWorkspaceCovered(probe.workspaceRoot, nextByRoot, nextScopes);
    return {
      ...base,
      workspaceRoot: probe.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: probe.homeDir ?? base.homeDir,
      workspaceInstruction: wsCovered ? [] : base.workspaceInstruction,
      byRoot: nextByRoot,
      scopes: nextScopes,
      checkedDirs: appendCheckedDirs(base.checkedDirs, probe.checkedDirs),
      overflowPaths: appendOverflowPaths(base.overflowPaths, skipped, MAX_OVERFLOW_PATHS),
    };
  });
}
