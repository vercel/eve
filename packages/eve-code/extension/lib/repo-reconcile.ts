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
  appendOverflowPaths,
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
  MAX_DISCOVERED_REPOSITORIES,
  MAX_OVERFLOW_PATHS,
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
const MAX_SUBSHELL_DEPTH = 2;

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SHELL_CONTROL_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "done",
  "fi",
  "while",
  "until",
  "case",
  "in",
]);
const REDIRECTION_TOKEN_PATTERN = /^(?:\d+|&)?[<>]/u;
const STANDALONE_REDIRECTION_PATTERN = /^(?:\d+|&)?(?:>>?|<<?[-<]?|<>|>[|&]|<&)$/u;
const SUBSHELL_EXECUTABLES = new Set(["sh", "bash", "zsh"]);
const TRANSPARENT_WRAPPERS = new Set(["env", "command", "exec", "sudo", "nohup", "time", "!", "{"]);
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-C",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-r",
    "-t",
    "-T",
    "-D",
    "--chdir",
  ]),
  exec: new Set(["-a"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
};
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
  "--list-cmds",
  "--attr-source",
]);
const GIT_RECONCILE_SUBCOMMANDS = new Set([
  "clone",
  "checkout",
  "switch",
  "fetch",
  "pull",
  "worktree",
  "submodule",
  "sparse-checkout",
  "reset",
  "init",
  "merge",
  "rebase",
  "remote",
  "cherry-pick",
  "revert",
]);
const GH_VALUE_FLAGS = new Set(["-R", "--repo", "--hostname"]);

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

function splitShellCommandSegments(command: string): readonly (readonly string[])[] {
  const segments: string[][] = [];
  let segment: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const flushToken = () => {
    if (current.length > 0) {
      segment.push(current);
      current = "";
    }
  };

  const flushSegment = () => {
    flushToken();
    if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  };

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
    if (ch === "#" && current.length === 0) {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "(" || ch === ")") {
      flushSegment();
      if (ch === "|" && (command[i + 1] === "|" || command[i + 1] === "&")) {
        i += 1;
      }
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === ">") {
        if (current.length > 0) flushToken();
        current += "&>";
        i += 1;
        if (command[i + 1] === ">") {
          current += ">";
          i += 1;
        }
        continue;
      }
      if (command[i + 1] === "&") i += 1;
      flushSegment();
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (current.length > 0 && !/^\d+$/u.test(current)) {
        flushToken();
      }
      current += ch;
      const next = command[i + 1];
      if (
        next === ch ||
        next === "&" ||
        (ch === "<" && next === ">") ||
        (ch === ">" && next === "|")
      ) {
        current += next;
        i += 1;
        if (ch === "<" && next === "<" && (command[i + 1] === "<" || command[i + 1] === "-")) {
          current += command[i + 1]!;
          i += 1;
        }
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushToken();
      continue;
    }
    current += ch;
  }

  flushSegment();
  return segments;
}

function executableBasename(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = slash === -1 ? token : token.slice(slash + 1);
  return base.replace(/\.exe$/iu, "");
}

function shouldReconcileCommandSegmentList(command: string, depth = 0): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    if (isMutatingCommandSegment(segment, depth)) return true;
  }
  return false;
}

function isMutatingCommandSegment(segment: readonly string[], depth = 0): boolean {
  let idx = 0;
  while (idx < segment.length) {
    const token = segment[idx]!;
    if (SHELL_CONTROL_KEYWORDS.has(token)) {
      idx += 1;
      continue;
    }
    if (STANDALONE_REDIRECTION_PATTERN.test(token)) {
      idx += 2;
      continue;
    }
    if (REDIRECTION_TOKEN_PATTERN.test(token)) {
      idx += 1;
      continue;
    }
    if (ENV_ASSIGNMENT_PATTERN.test(token)) {
      idx += 1;
      continue;
    }
    const base = executableBasename(token);
    if (TRANSPARENT_WRAPPERS.has(base)) {
      idx += 1;
      const valueFlags = WRAPPER_VALUE_FLAGS[base];
      while (idx < segment.length) {
        const arg = segment[idx]!;
        if (arg === "--") {
          idx += 1;
          break;
        }
        if (base === "env") {
          if (arg === "-S" || arg === "--split-string") {
            idx += 1;
            if (idx < segment.length) {
              if (
                depth < MAX_SUBSHELL_DEPTH &&
                shouldReconcileCommandSegmentList(segment[idx]!, depth + 1)
              ) {
                return true;
              }
              idx += 1;
            }
            continue;
          }
          if (arg.startsWith("--split-string=")) {
            if (
              depth < MAX_SUBSHELL_DEPTH &&
              shouldReconcileCommandSegmentList(arg.slice("--split-string=".length), depth + 1)
            ) {
              return true;
            }
            idx += 1;
            continue;
          }
          if (arg.startsWith("-S") && arg.length > 2) {
            if (
              depth < MAX_SUBSHELL_DEPTH &&
              shouldReconcileCommandSegmentList(arg.slice(2), depth + 1)
            ) {
              return true;
            }
            idx += 1;
            continue;
          }
        }
        if (arg.startsWith("-") && arg.length > 1) {
          idx += 1;
          if (valueFlags?.has(arg) && idx < segment.length) {
            idx += 1;
          }
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }

  if (idx >= segment.length) return false;
  const executable = executableBasename(segment[idx]!);

  if (SUBSHELL_EXECUTABLES.has(executable)) {
    if (depth >= MAX_SUBSHELL_DEPTH) return false;
    let subIdx = idx + 1;
    let hasCommandFlag = false;
    while (subIdx < segment.length) {
      const arg = segment[subIdx]!;
      if (arg === "--") {
        subIdx += 1;
        break;
      }
      if (arg === "-o" || arg === "+o" || arg === "--rcfile" || arg === "--init-file") {
        subIdx += 2;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) {
        if (!arg.startsWith("--")) {
          const flags = arg.slice(1);
          if (flags.includes("c")) hasCommandFlag = true;
          if (flags.endsWith("o")) {
            subIdx += 2;
            continue;
          }
        }
        subIdx += 1;
        continue;
      }
      if (arg.startsWith("+") && arg.length > 1) {
        subIdx += 1;
        continue;
      }
      break;
    }
    if (hasCommandFlag && subIdx < segment.length) {
      return shouldReconcileCommandSegmentList(segment[subIdx]!, depth + 1);
    }
    return false;
  }

  if (executable === "tar" || executable === "unzip") {
    return true;
  }

  if (executable === "git") {
    let subIdx = idx + 1;
    while (subIdx < segment.length) {
      const arg = segment[subIdx]!;
      if (arg === "--") return false;
      if (arg.startsWith("-")) {
        subIdx += 1;
        if (GIT_VALUE_FLAGS.has(arg)) subIdx += 1;
        continue;
      }
      return GIT_RECONCILE_SUBCOMMANDS.has(arg);
    }
    return false;
  }

  if (executable === "gh") {
    let firstPos: string | null = null;
    let secondPos: string | null = null;
    let hasCloneFlag = false;
    let subIdx = idx + 1;
    while (subIdx < segment.length) {
      const arg = segment[subIdx]!;
      if (arg === "--") break;
      if (arg.startsWith("-")) {
        if (arg === "--clone" || arg === "--clone=true" || arg === "-c") {
          hasCloneFlag = true;
        }
        subIdx += 1;
        if (GH_VALUE_FLAGS.has(arg)) subIdx += 1;
        continue;
      }
      if (firstPos === null) {
        firstPos = arg;
      } else if (secondPos === null) {
        secondPos = arg;
      }
      subIdx += 1;
    }
    if (firstPos === "pr" && secondPos === "checkout") return true;
    if (firstPos === "repo" && secondPos === "clone") return true;
    if (firstPos === "repo" && (secondPos === "fork" || secondPos === "create")) {
      return hasCloneFlag;
    }
    return false;
  }

  return false;
}

export function shouldReconcileCommand(
  command: string,
  workingDirectory: string | undefined,
  state: Pick<
    RepositorySessionState,
    "workspaceRoot" | "rawWorkspaceRoot" | "homeDir" | "byRoot" | "checkedDirs"
  >,
): boolean {
  if (shouldReconcileCommandSegmentList(command, 0)) return true;
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
  for (const segment of splitShellCommandSegments(command)) {
    for (const token of segment) tokens.push(token);
  }
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

function capRecordedRepositories(byRoot: Readonly<Record<string, RecordedRepository>>): {
  readonly byRoot: Record<string, RecordedRepository>;
  readonly overflowRoots: readonly string[];
} {
  const entries = Object.entries(byRoot);
  if (entries.length <= MAX_DISCOVERED_REPOSITORIES) {
    return { byRoot: { ...byRoot }, overflowRoots: [] };
  }
  const kept: Record<string, RecordedRepository> = {};
  const overflowRoots: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const [root, repo] = entries[i]!;
    if (i < MAX_DISCOVERED_REPOSITORIES) {
      kept[root] = repo;
    } else {
      overflowRoots.push(root);
    }
  }
  return { byRoot: kept, overflowRoots };
}

function collectMatchingRuleFileSpecs(
  repo: DiscoveredRepository,
  resolved: ResolvedRepositoriesConfig,
): readonly RepositoryInstructionSpec[] {
  const specs: RepositoryInstructionSpec[] = [];
  for (const rule of resolved.rules) {
    if (!matchesRepositoryRule(repo, rule.match)) continue;
    if (rule.files !== undefined) specs.push(...rule.files);
  }
  return specs;
}

function areInstructionSpecsEqual(
  a: readonly RepositoryInstructionSpec[] | undefined,
  b: readonly RepositoryInstructionSpec[] | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (typeof left === "string" || typeof right === "string") {
      if (left !== right) return false;
    } else {
      if (left.length !== right.length) return false;
      for (let j = 0; j < left.length; j += 1) {
        if (left[j] !== right[j]) return false;
      }
    }
  }
  return true;
}

async function readMatchingRuleFiles(
  sandbox: RepositorySandbox,
  repo: DiscoveredRepository,
  specs: readonly RepositoryInstructionSpec[],
  resolved: ResolvedRepositoriesConfig,
): Promise<{
  readonly files: readonly RepositoryInstructionFile[];
  readonly overflowPaths: readonly string[];
  readonly fingerprint?: string;
}> {
  if (specs.length === 0) return { files: [], overflowPaths: [], fingerprint: "empty" };
  const loaded = await readRepositorySpecFiles(sandbox, repo.root, specs, {
    maxFileBytes: resolved.maxFileBytes,
    maxTotalBytes: resolved.maxTotalBytes,
    sparse: repo.sparse,
  });
  const defaultPaths = new Set(repo.instructions.map((file) => file.relativePath));
  const seen = new Set<string>();
  const unique: RepositoryInstructionFile[] = [];
  for (const file of loaded.files) {
    if (defaultPaths.has(file.relativePath) || seen.has(file.relativePath)) continue;
    seen.add(file.relativePath);
    unique.push(file);
  }
  const cacheableFingerprint =
    loaded.overflowPaths.length === 0 && !unique.some((file) => file.source === "unavailable")
      ? loaded.fingerprint
      : undefined;
  return {
    files: unique,
    overflowPaths: loaded.overflowPaths,
    ...(cacheableFingerprint !== undefined && { fingerprint: cacheableFingerprint }),
  };
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
  fileFingerprint?: string,
): Promise<{
  readonly repo: RecordedRepository;
  readonly overflowPaths: readonly string[];
}> {
  const ruleFileSpecs = collectMatchingRuleFileSpecs(repo, resolved);
  let ruleFiles: readonly RepositoryInstructionFile[] = [];
  let ruleOverflowPaths: readonly string[] = [];
  let ruleFileFingerprint: string | undefined;
  let ruleFilesLoaded = ruleFileSpecs.length === 0;
  if (ruleFileSpecs.length > 0) {
    try {
      const matched = await readMatchingRuleFiles(sandbox, repo, ruleFileSpecs, resolved);
      ruleFiles = matched.files;
      ruleOverflowPaths = matched.overflowPaths;
      ruleFileFingerprint = matched.fingerprint;
      ruleFilesLoaded = true;
    } catch {}
  }
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
    repo: {
      root: repo.root,
      slug: repo.slug,
      remote: repo.remote,
      head: repo.head,
      branch: repo.branch,
      sparse: repo.sparse,
      instructions: repo.instructions,
      ...(fileFingerprint !== undefined && { fileFingerprint }),
      ruleFiles,
      ...(ruleFilesLoaded && { ruleFileSpecs }),
      ...(ruleFilesLoaded && ruleFileFingerprint !== undefined && { ruleFileFingerprint }),
      ...(ruleOverflowPaths.length > 0 && { ruleOverflowPaths }),
      ruleInstructions,
      ruleSkills,
      enteredAtHead: repo.head,
    },
    overflowPaths: ruleOverflowPaths,
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
  const knownFingerprints: Record<string, string> = {};
  const knownRuleProbes: Record<
    string,
    { readonly specs: readonly RepositoryInstructionSpec[]; readonly fingerprint: string }
  > = {};
  for (const [root, recorded] of Object.entries(snapshot.byRoot)) {
    if (
      recorded.fileFingerprint !== undefined &&
      !recorded.instructions.some((file) => file.source === "unavailable")
    ) {
      knownFingerprints[root] = recorded.fileFingerprint;
    }
    if (
      recorded.ruleFileSpecs !== undefined &&
      recorded.ruleFileSpecs.length > 0 &&
      recorded.ruleFileFingerprint !== undefined &&
      (recorded.ruleOverflowPaths?.length ?? 0) === 0 &&
      !recorded.ruleFiles.some((file) => file.source === "unavailable")
    ) {
      knownRuleProbes[root] = {
        specs: recorded.ruleFileSpecs,
        fingerprint: recorded.ruleFileFingerprint,
      };
    }
  }

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
      knownFingerprints,
      knownRuleProbes,
      pendingJobs: options.pendingJobs,
    });
  } catch {
    return;
  }

  const discoveredRepos = new Map<string, DiscoveredRepository>();
  const extraOverflowPaths: string[] = [];
  for (const repo of discovery.repositories) {
    if (discoveredRepos.has(repo.root)) continue;
    if (discoveredRepos.size >= MAX_DISCOVERED_REPOSITORIES) {
      extraOverflowPaths.push(repo.root);
      continue;
    }
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
      const onboarded = await onboardRepository(
        sandbox,
        repo,
        resolved,
        ruleCtx,
        discovery.fileFingerprints[repo.root],
      );
      upsertedRepos[repo.root] = onboarded.repo;
      extraOverflowPaths.push(...onboarded.overflowPaths);
      changed = true;
      continue;
    }

    const filesUnchanged = discovery.unchangedFileRoots.has(repo.root);
    const instructions = filesUnchanged ? existing.instructions : repo.instructions;
    const nextFileFingerprint = filesUnchanged
      ? existing.fileFingerprint
      : discovery.fileFingerprints[repo.root];
    const effectiveRepo: DiscoveredRepository = filesUnchanged ? { ...repo, instructions } : repo;

    const headChanged = existing.head !== effectiveRepo.head;
    const repoMetaChanged =
      headChanged ||
      existing.slug !== effectiveRepo.slug ||
      existing.remote !== effectiveRepo.remote ||
      existing.branch !== effectiveRepo.branch ||
      existing.sparse !== effectiveRepo.sparse;

    const matchingRuleFileSpecs = collectMatchingRuleFileSpecs(effectiveRepo, resolved);
    const ruleFileSpecsChanged = !areInstructionSpecsEqual(
      existing.ruleFileSpecs,
      matchingRuleFileSpecs,
    );
    const unchangedDefaultInstructions = filesUnchanged;
    const ruleFilesUnchanged = discovery.unchangedRuleFileRoots.has(repo.root);
    let ruleFiles: readonly RepositoryInstructionFile[] =
      matchingRuleFileSpecs.length > 0 ? existing.ruleFiles : [];
    let ruleOverflowPaths: readonly string[] =
      matchingRuleFileSpecs.length > 0 ? (existing.ruleOverflowPaths ?? []) : [];
    let nextRuleFileSpecs: readonly RepositoryInstructionSpec[] | undefined =
      matchingRuleFileSpecs.length === 0 ? matchingRuleFileSpecs : existing.ruleFileSpecs;
    let nextRuleFileFingerprint: string | undefined =
      matchingRuleFileSpecs.length === 0 ? undefined : existing.ruleFileFingerprint;

    if (matchingRuleFileSpecs.length > 0) {
      const shouldRefreshRuleFiles =
        repoMetaChanged ||
        !unchangedDefaultInstructions ||
        ruleFileSpecsChanged ||
        !ruleFilesUnchanged ||
        existing.ruleFileSpecs === undefined ||
        (existing.ruleOverflowPaths?.length ?? 0) > 0 ||
        existing.ruleFiles.some((file) => file.source === "unavailable");
      if (shouldRefreshRuleFiles) {
        try {
          const matched = await readMatchingRuleFiles(
            sandbox,
            effectiveRepo,
            matchingRuleFileSpecs,
            resolved,
          );
          ruleFiles = matched.files;
          ruleOverflowPaths = matched.overflowPaths;
          nextRuleFileSpecs = matchingRuleFileSpecs;
          nextRuleFileFingerprint = matched.fingerprint;
        } catch {
          nextRuleFileSpecs = undefined;
          nextRuleFileFingerprint = undefined;
        }
      }
      extraOverflowPaths.push(...ruleOverflowPaths);
    }

    const metadataChanged =
      repoMetaChanged ||
      existing.fileFingerprint !== nextFileFingerprint ||
      !areInstructionSpecsEqual(existing.ruleFileSpecs, nextRuleFileSpecs) ||
      existing.ruleFileFingerprint !== nextRuleFileFingerprint ||
      (!filesUnchanged && JSON.stringify(existing.instructions) !== JSON.stringify(instructions)) ||
      JSON.stringify(existing.ruleFiles) !== JSON.stringify(ruleFiles) ||
      JSON.stringify(existing.ruleOverflowPaths ?? []) !== JSON.stringify(ruleOverflowPaths);

    if (headChanged) {
      headChangedRoots.push(repo.root);
    }

    if (metadataChanged) {
      const {
        fileFingerprint: _prevFileFingerprint,
        ruleFileSpecs: _prevRuleFileSpecs,
        ruleFileFingerprint: _prevRuleFileFingerprint,
        ruleOverflowPaths: _prevRuleOverflowPaths,
        ...restExisting
      } = existing;
      const nextRecorded: RecordedRepository = {
        ...restExisting,
        slug: effectiveRepo.slug,
        remote: effectiveRepo.remote,
        head: effectiveRepo.head,
        branch: effectiveRepo.branch,
        sparse: effectiveRepo.sparse,
        instructions,
        ...(nextFileFingerprint !== undefined && { fileFingerprint: nextFileFingerprint }),
        ruleFiles,
        ...(nextRuleFileSpecs !== undefined && { ruleFileSpecs: nextRuleFileSpecs }),
        ...(nextRuleFileFingerprint !== undefined && {
          ruleFileFingerprint: nextRuleFileFingerprint,
        }),
        ...(ruleOverflowPaths.length > 0 && { ruleOverflowPaths }),
      };
      upsertedRepos[repo.root] = nextRecorded;
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

  const previewByRootUnbounded: Record<string, RecordedRepository> = { ...snapshot.byRoot };
  for (const deleted of deletedRoots) delete previewByRootUnbounded[deleted];
  Object.assign(previewByRootUnbounded, upsertedRepos);
  const previewCapped = capRecordedRepositories(previewByRootUnbounded);
  const previewByRoot = previewCapped.byRoot;
  const previewOverflowPaths = appendOverflowPaths(
    [],
    [...discovery.overflowPaths, ...extraOverflowPaths, ...previewCapped.overflowRoots],
    MAX_OVERFLOW_PATHS,
  );
  const workspaceCovered =
    findKnownEnclosingRoot(discovery.workspaceRoot, previewByRoot) !== null ||
    discovery.workspaceRoot in snapshot.scopes;
  const previewWorkspaceInstruction = workspaceCovered ? [] : discovery.workspaceInstructions;
  if (
    JSON.stringify(snapshot.workspaceInstruction) !== JSON.stringify(previewWorkspaceInstruction) ||
    JSON.stringify(snapshot.overflowPaths) !== JSON.stringify(previewOverflowPaths)
  ) {
    changed = true;
  }

  if (!changed) return;

  repoState.update((latest) => {
    const nextByRootUnbounded: Record<string, RecordedRepository> = { ...latest.byRoot };
    for (const deleted of deletedRoots) delete nextByRootUnbounded[deleted];
    Object.assign(nextByRootUnbounded, upsertedRepos);
    const capped = capRecordedRepositories(nextByRootUnbounded);
    const nextByRoot = capped.byRoot;

    const invalidatedRoots = new Set([
      ...deletedRoots,
      ...headChangedRoots,
      ...capped.overflowRoots,
    ]);
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
    const nextOverflowPaths = appendOverflowPaths(
      [],
      [...discovery.overflowPaths, ...extraOverflowPaths, ...capped.overflowRoots],
      MAX_OVERFLOW_PATHS,
    );

    return {
      ...latest,
      workspaceRoot: discovery.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: discovery.homeDir ?? latest.homeDir,
      workspaceInstruction: nextWorkspaceInstruction,
      byRoot: nextByRoot,
      scopes: nextScopes,
      checkedDirs: nextCheckedDirs,
      overflowPaths: nextOverflowPaths,
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
  const sparseRepoRoots = new Set(
    Object.values(current.byRoot)
      .filter((repo) => repo.sparse)
      .map((repo) => repo.root),
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
  const skippedEnclosingRoots: string[] = [];
  if (probe.enclosingRepo !== null && !(probe.enclosingRepo.root in current.byRoot)) {
    if (Object.keys(current.byRoot).length < MAX_DISCOVERED_REPOSITORIES) {
      const entered = await onboardRepository(
        sandbox,
        probe.enclosingRepo,
        resolved,
        ruleCtx,
        probe.enclosingRepoFingerprint,
      );
      onboarded = entered.repo;
      skippedEnclosingRoots.push(...entered.overflowPaths);
    } else {
      skippedEnclosingRoots.push(probe.enclosingRepo.root);
    }
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
  const incomingOverflow = [...probe.overflowPaths, ...skippedEnclosingRoots];
  const previewOverflow = appendOverflowPaths(
    current.overflowPaths,
    incomingOverflow,
    MAX_OVERFLOW_PATHS,
  );
  const overflowChanged = JSON.stringify(current.overflowPaths) !== JSON.stringify(previewOverflow);

  if (
    onboarded === null &&
    !scopesChanged &&
    !checkedChanged &&
    !workspaceChanged &&
    !overflowChanged
  ) {
    return;
  }

  repoState.update((latest) => {
    const nextByRoot: Record<string, RecordedRepository> = { ...latest.byRoot };
    const extraSkipped: string[] = [...incomingOverflow];
    let addedOnboarded = false;
    if (onboarded !== null) {
      if (
        onboarded.root in nextByRoot ||
        Object.keys(nextByRoot).length < MAX_DISCOVERED_REPOSITORIES
      ) {
        nextByRoot[onboarded.root] = onboarded;
        addedOnboarded = true;
      } else {
        extraSkipped.push(onboarded.root);
      }
    }

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
    const nextOverflowPaths = appendOverflowPaths(
      latest.overflowPaths,
      extraSkipped,
      MAX_OVERFLOW_PATHS,
    );
    const latestOverflowChanged =
      JSON.stringify(latest.overflowPaths) !== JSON.stringify(nextOverflowPaths);

    return {
      ...latest,
      workspaceRoot: probe.workspaceRoot,
      rawWorkspaceRoot,
      homeDir: probe.homeDir ?? latest.homeDir,
      workspaceInstruction: workspaceCovered ? [] : latest.workspaceInstruction,
      byRoot: nextByRoot,
      scopes: nextScopes,
      checkedDirs: appendCheckedDirs(latest.checkedDirs, probe.checkedDirs),
      overflowPaths: nextOverflowPaths,
      revision:
        addedOnboarded || scopesChanged || latestOverflowChanged
          ? latest.revision + 1
          : latest.revision,
    };
  });
}

export async function discoverWorkspaceReadOnly(
  sandbox: RepositorySandbox,
  resolved: ResolvedRepositoriesConfig,
): Promise<
  Pick<
    RepositorySessionState,
    "workspaceRoot" | "workspaceInstruction" | "byRoot" | "overflowPaths"
  >
> {
  const discovery = await discoverWorkspace(sandbox, {
    roots: resolved.roots,
    instructions: resolved.instructions,
    maxFileBytes: resolved.maxFileBytes,
    maxTotalBytes: resolved.maxTotalBytes,
    includeWorkspaceInstructions: true,
  });

  const byRoot: Record<string, RecordedRepository> = {};
  const extraOverflow: string[] = [];
  for (const repo of discovery.repositories) {
    if (repo.root in byRoot) continue;
    if (Object.keys(byRoot).length >= MAX_DISCOVERED_REPOSITORIES) {
      extraOverflow.push(repo.root);
      continue;
    }
    const ruleFileSpecs = collectMatchingRuleFileSpecs(repo, resolved);
    let ruleFiles: readonly RepositoryInstructionFile[] = [];
    let ruleOverflowPaths: readonly string[] = [];
    let ruleFileFingerprint: string | undefined;
    let ruleFilesLoaded = ruleFileSpecs.length === 0;
    if (ruleFileSpecs.length > 0) {
      try {
        const matched = await readMatchingRuleFiles(sandbox, repo, ruleFileSpecs, resolved);
        ruleFiles = matched.files;
        ruleOverflowPaths = matched.overflowPaths;
        ruleFileFingerprint = matched.fingerprint;
        ruleFilesLoaded = true;
        extraOverflow.push(...matched.overflowPaths);
      } catch {}
    }
    const fileFingerprint = discovery.fileFingerprints[repo.root];
    byRoot[repo.root] = {
      root: repo.root,
      slug: repo.slug,
      remote: repo.remote,
      head: repo.head,
      branch: repo.branch,
      sparse: repo.sparse,
      instructions: repo.instructions,
      ...(fileFingerprint !== undefined && { fileFingerprint }),
      ruleFiles,
      ...(ruleFilesLoaded && { ruleFileSpecs }),
      ...(ruleFilesLoaded && ruleFileFingerprint !== undefined && { ruleFileFingerprint }),
      ...(ruleOverflowPaths.length > 0 && { ruleOverflowPaths }),
      ruleInstructions: [],
      ruleSkills: {},
      enteredAtHead: repo.head,
    };
  }

  return {
    workspaceRoot: discovery.workspaceRoot,
    workspaceInstruction: discovery.workspaceInstructions,
    byRoot,
    overflowPaths: appendOverflowPaths(
      [],
      [...discovery.overflowPaths, ...extraOverflow],
      MAX_OVERFLOW_PATHS,
    ),
  };
}
