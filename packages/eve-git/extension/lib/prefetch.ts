import { posix } from "node:path";
import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

export const DEFAULT_PREFETCH_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];

const PREFETCH_TIMEOUT_MS = 5_000;

const GIT_REF_SUBCOMMANDS = new Set(["fetch", "pull", "checkout", "switch", "sparse-checkout"]);

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--attr-source",
]);

const GIT_CLONE_VALUE_FLAGS = new Set([
  "-o",
  "--origin",
  "-b",
  "--branch",
  "-u",
  "--upload-pack",
  "--template",
  "-c",
  "--config",
  "--depth",
  "--shallow-since",
  "--shallow-exclude",
  "--reference",
  "--reference-if-able",
  "--separate-git-dir",
  "--ref-format",
  "-j",
  "--jobs",
  "--filter",
  "--server-option",
  "--bundle-uri",
]);

const GH_REPO_CLONE_VALUE_FLAGS = new Set(["-u", "--upstream-remote-name"]);

export function isValidPrefetchPath(value: string): boolean {
  if (value.trim().length === 0) return false;
  if (value.startsWith("/") || /[\0\r\n\\]/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isWithinWorkspace(targetPath: string, workspaceRoot: string): boolean {
  const normalizedWorkspace = posix.resolve("/", workspaceRoot);
  const normalizedTarget = posix.resolve("/", targetPath);
  return (
    normalizedWorkspace === "/" ||
    normalizedTarget === normalizedWorkspace ||
    normalizedTarget.startsWith(`${normalizedWorkspace}/`)
  );
}

export function resolvePrefetchTarget(
  argv: readonly string[],
  workingDirectory: string,
  workspaceRoot: string,
  repository?: string,
): string | null {
  const executable = argv[0];
  let candidate: string | null = null;
  if (executable === "git") {
    candidate = resolveGitPrefetchTarget(argv, workingDirectory, repository);
  } else if (executable === "gh" && argv[1] === "repo" && argv[2] === "clone") {
    candidate = resolveGhRepoCloneTarget(argv, workingDirectory, repository);
  }
  if (!candidate || !isWithinWorkspace(candidate, workspaceRoot)) return null;
  return candidate;
}

function resolveGitPrefetchTarget(
  argv: readonly string[],
  workingDirectory: string,
  repository: string | undefined,
): string | null {
  let baseDir = workingDirectory;
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--") return null;
    if (!arg.startsWith("-")) break;
    if (arg === "-C") {
      if (index + 1 >= argv.length) return null;
      baseDir = posix.resolve(baseDir, argv[index + 1]!);
      index += 2;
      continue;
    }
    if (arg.startsWith("-C")) {
      baseDir = posix.resolve(baseDir, arg.slice(2));
      index += 1;
      continue;
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  const subcommand = argv[index];
  if (!subcommand) return null;
  if (subcommand === "clone") {
    return resolveGitCloneTarget(argv.slice(index + 1), baseDir, repository);
  }
  if (GIT_REF_SUBCOMMANDS.has(subcommand)) {
    return baseDir;
  }
  return null;
}

function resolveGitCloneTarget(
  args: readonly string[],
  baseDir: string,
  repository: string | undefined,
): string | null {
  const positionals: string[] = [];
  let afterDoubleDash = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      index += 1;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      index += GIT_CLONE_VALUE_FLAGS.has(arg) ? 2 : 1;
      continue;
    }
    positionals.push(arg);
    index += 1;
  }
  if (positionals[1]) {
    return posix.resolve(baseDir, positionals[1]);
  }
  const repoName = repoNameFromSpec(positionals[0]) ?? repoNameFromSpec(repository);
  return repoName ? posix.resolve(baseDir, repoName) : null;
}

function resolveGhRepoCloneTarget(
  argv: readonly string[],
  workingDirectory: string,
  repository: string | undefined,
): string | null {
  const positionals: string[] = [];
  let index = 3;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      index += GH_REPO_CLONE_VALUE_FLAGS.has(arg) ? 2 : 1;
      continue;
    }
    positionals.push(arg);
    index += 1;
  }
  if (positionals[1]) {
    return posix.resolve(workingDirectory, positionals[1]);
  }
  const repoName = repoNameFromSpec(positionals[0]) ?? repoNameFromSpec(repository);
  return repoName ? posix.resolve(workingDirectory, repoName) : null;
}

function repoNameFromSpec(spec: string | undefined): string | null {
  if (!spec) return null;
  const trimmed = spec
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  if (!trimmed) return null;
  const segment = trimmed.split(/[/:]/u).pop();
  if (!segment || segment === "." || segment === "..") return null;
  return segment;
}

export function buildPrefetchCommand(
  targetPath: string,
  workspaceRoot: string,
  prefetchFiles: readonly string[],
): string | null {
  if (!isWithinWorkspace(targetPath, workspaceRoot)) return null;
  const files = [...new Set(prefetchFiles.filter(isValidPrefetchPath))];
  if (files.length === 0) return null;
  const quotedFiles = files.map(shellQuote).join(" ");
  return [
    `canon() { realpath -e -- "$1" 2>/dev/null || (cd -P -- "$1" 2>/dev/null && pwd -P); }`,
    `workspace=$(canon ${shellQuote(workspaceRoot)}) || exit 0`,
    `top=$(git -C ${shellQuote(targetPath)} rev-parse --show-toplevel 2>/dev/null) || exit 0`,
    `top=$(canon "$top") || exit 0`,
    `case "$top" in`,
    `  "$workspace"|"$workspace"/*) ;;`,
    `  *) [ "$workspace" = "/" ] || exit 0 ;;`,
    `esac`,
    `git -C "$top" config --get-regexp '^remote\\..*\\.promisor$' >/dev/null 2>&1 || exit 0`,
    `GIT_NO_LAZY_FETCH=1 git -c core.quotePath=false --literal-pathspecs -C "$top" ls-tree HEAD -- ${quotedFiles} 2>/dev/null |`,
    `  while IFS=' \t' read -r mode kind oid path; do`,
    `    [ "$mode" = "100644" ] || [ "$mode" = "100755" ] || continue`,
    `    [ "$kind" = "blob" ] || continue`,
    `    [ -n "$oid" ] && [ -n "$path" ] || continue`,
    `    [ -f "$top/$path" ] && continue`,
    `    GIT_NO_LAZY_FETCH=1 git -C "$top" cat-file -e "$oid" 2>/dev/null && continue`,
    `    printf '%s\\n' "$oid"`,
    `  done |`,
    `  git -C "$top" cat-file --batch-check >/dev/null 2>&1 || true`,
    `exit 0`,
  ].join("\n");
}

export interface PrefetchRepositoryFilesOptions {
  readonly argv: readonly string[];
  readonly workingDirectory: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly prefetchFiles?: readonly string[];
  readonly sandbox: Pick<SandboxSession, "run">;
  readonly env: Readonly<Record<string, string>>;
  readonly abortSignal?: AbortSignal;
}

export async function prefetchRepositoryFiles({
  argv,
  workingDirectory,
  workspaceRoot,
  repository,
  prefetchFiles,
  sandbox,
  env,
  abortSignal,
}: PrefetchRepositoryFilesOptions): Promise<void> {
  if (abortSignal?.aborted) return;
  const candidates = prefetchFiles ?? DEFAULT_PREFETCH_FILES;
  if (candidates.length === 0) return;
  const targetPath = resolvePrefetchTarget(argv, workingDirectory, workspaceRoot, repository);
  if (!targetPath) return;
  const command = buildPrefetchCommand(targetPath, workspaceRoot, candidates);
  if (!command) return;
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortSignal?.reason);
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Prefetch timed out.", "TimeoutError"));
  }, PREFETCH_TIMEOUT_MS);
  timer.unref?.();
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    await sandbox.run({ command, env, signal: controller.signal });
  } catch {
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}
