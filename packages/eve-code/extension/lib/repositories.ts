import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { SandboxSession } from "eve/sandbox";

import type {
  DiscoveredRepository,
  RepositoriesConfig,
  RepositoryInstructionFile,
  RepositoryInstructionSpec,
  RepositoryRule,
} from "../extension.ts";
import { commandFailureDetail } from "./command-failure.ts";

export const DEFAULT_REPOSITORY_ROOTS: readonly string[] = ["."];
export const DEFAULT_REPOSITORY_INSTRUCTIONS: readonly RepositoryInstructionSpec[] = [
  ["AGENTS.md", "CLAUDE.md"],
];
export const DEFAULT_MAX_FILE_BYTES = 64_000;
export const DEFAULT_MAX_TOTAL_BYTES = 256_000;

const PROMISOR_FETCH_TIMEOUT_SECONDS = 5;

/**
 * Options for {@link discoverRepositories}.
 */
export interface DiscoverRepositoriesOptions {
  /** Workspace-relative root directories to scan up to depth 3. Defaults to `["."]`. */
  readonly roots?: readonly string[];
  /** Repository-relative instruction specs to load for each discovered repository. Defaults to `[["AGENTS.md", "CLAUDE.md"]]`; pass `[]` to skip reading instruction files. */
  readonly instructions?: readonly RepositoryInstructionSpec[];
  /** Maximum UTF-8 bytes read per instruction file before truncation. Defaults to `64_000`. */
  readonly maxFileBytes?: number;
}

/**
 * Options for {@link readRepositoryFile}.
 */
export interface ReadRepositoryFileOptions {
  /** Maximum UTF-8 bytes read before truncation. Defaults to `64_000`. */
  readonly maxFileBytes?: number;
}

export interface ResolvedRepositoriesConfig {
  readonly roots: readonly string[];
  readonly instructions: readonly RepositoryInstructionSpec[];
  readonly scopedInstructions: boolean;
  readonly discoverOnStart: "eager" | "on-sandbox-use";
  readonly rules: readonly RepositoryRule[];
  readonly syncAfter: NonNullable<RepositoriesConfig["syncAfter"]>;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface WorkspaceDiscoveryResult {
  readonly workspaceRoot: string;
  readonly homeDir: string | null;
  readonly repositories: readonly DiscoveredRepository[];
  readonly workspaceInstructions: readonly RepositoryInstructionFile[];
}

export interface ScopedProbeResult {
  readonly workspaceRoot: string;
  readonly homeDir: string | null;
  readonly enclosingRepoRoot: string | null;
  readonly enclosingRepo: DiscoveredRepository | null;
  readonly checkedDirs: readonly string[];
  readonly scopes: readonly {
    readonly dir: string;
    readonly files: readonly RepositoryInstructionFile[];
  }[];
}

export type RepositorySandbox = Pick<SandboxSession, "resolvePath" | "run">;

export function resolveRepositoriesConfig(
  config: RepositoriesConfig | undefined,
): ResolvedRepositoriesConfig {
  return {
    roots: config?.roots ?? DEFAULT_REPOSITORY_ROOTS,
    instructions: config?.instructions ?? DEFAULT_REPOSITORY_INSTRUCTIONS,
    scopedInstructions: config?.scopedInstructions ?? true,
    discoverOnStart: config?.discoverOnStart ?? "eager",
    rules: config?.rules ?? [],
    syncAfter: config?.syncAfter ?? [],
    maxFileBytes: config?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: config?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
}

export function isValidRelativePath(value: string): boolean {
  if (value.trim().length === 0) return false;
  if (value.startsWith("/") || /[\0\r\n\\]/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isValidRootPath(value: string): boolean {
  return value === "." || isValidRelativePath(value);
}

function validateMaxFileBytes(maxFileBytes: number | undefined): number {
  if (maxFileBytes === undefined) return DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error(`Invalid maxFileBytes ${String(maxFileBytes)}: must be a positive integer.`);
  }
  return maxFileBytes;
}

function validateRoots(roots: readonly string[] | undefined): readonly string[] {
  const list = roots ?? DEFAULT_REPOSITORY_ROOTS;
  for (const root of list) {
    if (!isValidRootPath(root)) {
      throw new Error(
        `Invalid repository root path ${JSON.stringify(root)}: must be "." or a relative POSIX path without traversal or control characters.`,
      );
    }
  }
  return list;
}

function validateInstructionSpecs(
  specs: readonly RepositoryInstructionSpec[] | undefined,
): readonly (readonly string[])[] {
  const list = specs ?? DEFAULT_REPOSITORY_INSTRUCTIONS;
  const result: (readonly string[])[] = [];
  for (const spec of list) {
    if (typeof spec === "string") {
      if (!isValidRelativePath(spec)) {
        throw new Error(
          `Invalid repository instruction path ${JSON.stringify(spec)}: must be a relative POSIX path without traversal or control characters.`,
        );
      }
      result.push([spec]);
      continue;
    }
    if (spec.length === 0) {
      throw new Error("Invalid repository instruction spec: fallback tuple must not be empty.");
    }
    for (const candidate of spec) {
      if (!isValidRelativePath(candidate)) {
        throw new Error(
          `Invalid repository instruction path ${JSON.stringify(candidate)}: must be a relative POSIX path without traversal or control characters.`,
        );
      }
    }
    result.push([...spec]);
  }
  return result;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellResolveTargetExpr(sandbox: RepositorySandbox, rawPath: string): string {
  if (rawPath === "~" || rawPath === "$HOME") {
    return '"$HOME"';
  }
  if (rawPath.startsWith("~/")) {
    return `"$HOME"/${shellQuote(rawPath.slice(2))}`;
  }
  if (rawPath.startsWith("$HOME/")) {
    return `"$HOME"/${shellQuote(rawPath.slice("$HOME/".length))}`;
  }
  return shellQuote(sandbox.resolvePath(rawPath));
}

export function sanitizeRemoteUrl(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return trimmed
        .replace(/[?#].*$/u, "")
        .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]*@/u, "$1");
    }
  }
  const scp = /^(.+)@([^:@/]+):([^?#]+)(?:[?#].*)?$/u.exec(trimmed);
  if (scp !== null) {
    const [, userinfo, host, repoPath] = scp;
    if (userinfo === "git") {
      return `git@${host}:${repoPath}`;
    }
    return `${host}:${repoPath}`;
  }
  return trimmed.replace(/[?#].*$/u, "");
}

export function parseRepositorySlug(remote: string): string | null {
  const sanitized = sanitizeRemoteUrl(remote);
  if (sanitized.length === 0) return null;
  if (/^file:\/\//iu.test(sanitized) || sanitized.startsWith("/")) return null;
  let pathPart: string | null = null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(sanitized)) {
    try {
      pathPart = new URL(sanitized).pathname;
    } catch {
      return null;
    }
  } else {
    const scp = /^(?:[^@:/]+@)?([^:/]+):(.+)$/u.exec(sanitized);
    if (scp !== null) {
      pathPart = scp[2] ?? null;
    }
  }
  if (pathPart === null) return null;
  const normalized = pathPart
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  return segments.join("/");
}

export function matchesRepositoryRule(
  repo: DiscoveredRepository,
  match: RepositoryRule["match"],
): boolean {
  if (match === undefined) return true;
  if (typeof match === "function") return Boolean(match(repo));
  if (match instanceof RegExp) {
    if (repo.slug !== null) {
      match.lastIndex = 0;
      if (match.test(repo.slug)) return true;
    }
    match.lastIndex = 0;
    return match.test(repo.root);
  }
  if (match === "*") return true;
  if (repo.slug === null) return false;
  const candidate = repo.slug.toLowerCase();
  const pattern = match.toLowerCase();
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return candidate.startsWith(prefix) && candidate.length > prefix.length;
  }
  return candidate === pattern;
}

function normalizeSpecs(
  specs: readonly RepositoryInstructionSpec[],
): readonly (readonly string[])[] {
  const result: (readonly string[])[] = [];
  for (const spec of specs) {
    const candidates = typeof spec === "string" ? [spec] : [...spec];
    const valid = candidates.filter(isValidRelativePath);
    if (valid.length > 0) result.push(valid);
  }
  return result;
}

function createBoundary(): string {
  return `__EVE_REPO_${randomBytes(12).toString("hex")}__`;
}

function shellHelpers(boundary: string, maxFileBytes: number): string {
  const b = shellQuote(boundary);
  const headBytes = Math.max(1, Math.floor(maxFileBytes)) + 1;
  return [
    `B=${b}`,
    `MAX_HEAD=${headBytes}`,
    `canon_path() {`,
    `  [ -e "$1" ] || return 1`,
    `  if realpath -e -- "$1" 2>/dev/null; then return 0; fi`,
    `  if realpath -- "$1" 2>/dev/null; then return 0; fi`,
    `  if [ -d "$1" ]; then (cd -P -- "$1" 2>/dev/null && pwd -P); return $?; fi`,
    `  if readlink -f -- "$1" 2>/dev/null; then return 0; fi`,
    `  if [ -L "$1" ]; then return 1; fi`,
    `  _cd_dir=$(cd -P -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || return 1`,
    `  printf '%s/%s\\n' "$_cd_dir" "$(basename -- "$1")"`,
    `}`,
    `run_with_timeout() {`,
    `  _secs="$1"; shift`,
    `  if command -v timeout >/dev/null 2>&1; then`,
    `    timeout -k 2 "$_secs" "$@"`,
    `  elif command -v gtimeout >/dev/null 2>&1; then`,
    `    gtimeout -k 2 "$_secs" "$@"`,
    `  elif command -v perl >/dev/null 2>&1; then`,
    `    perl -e 'my $secs = shift @ARGV; my $pid = fork(); exit 127 unless defined $pid; if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127; } $SIG{ALRM} = sub { kill 9, -$pid; exit 124; }; alarm $secs; waitpid($pid, 0); my $st = $?; alarm 0; exit(($st & 127) ? 128 + ($st & 127) : ($st >> 8));' "$_secs" "$@"`,
    `  else`,
    `    return 1`,
    `  fi`,
    `}`,
    `path_within() {`,
    `  _child="$1"; _parent="$2"`,
    `  if [ "$_parent" = "/" ]; then`,
    `    case "$_child" in /*) return 0 ;; *) return 1 ;; esac`,
    `  fi`,
    `  case "$_child" in "$_parent"/*) return 0 ;; *) return 1 ;; esac`,
    `}`,
    `emit_file_worktree() {`,
    `  _scope="$1"; _base="$2"; _rel="$3"; _full="$4"`,
    `  if [ ! -f "$_full" ] || [ ! -s "$_full" ]; then return 1; fi`,
    `  _real=$(canon_path "$_full" 2>/dev/null || true)`,
    `  [ -n "$_real" ] || return 1`,
    `  path_within "$_real" "$_base" || return 1`,
    `  head -c "$MAX_HEAD" -- "$_real" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `  printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE worktree\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_real" "$B" "$_rel" "$B" "$B"`,
    `  head -c "$MAX_HEAD" -- "$_real"`,
    `  printf '\\n%s CONTENT_END\\n' "$B"`,
    `  return 0`,
    `}`,
    `emit_file_repo() {`,
    `  _scope="$1"; _repo="$2"; _rel="$3"`,
    `  if [ "$_repo" = "/" ]; then _full="/$_rel"; else _full="$_repo/$_rel"; fi`,
    `  if [ -e "$_full" ] || [ -L "$_full" ]; then`,
    `    emit_file_worktree "$_scope" "$_repo" "$_rel" "$_full"`,
    `    return $?`,
    `  fi`,
    `  _ls=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -c core.quotePath=false --literal-pathspecs -C "$_repo" ls-tree HEAD -- "$_rel" 2>/dev/null | head -n 1 || true)`,
    `  [ -n "$_ls" ] || return 1`,
    `  IFS=' \t' read -r _mode _kind _oid _rest <<EOF`,
    `$_ls`,
    `EOF`,
    `  [ "$_kind" = "blob" ] || return 1`,
    `  [ "$_mode" = "100644" ] || [ "$_mode" = "100755" ] || return 1`,
    `  [ -n "$_oid" ] || return 1`,
    `  if GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then`,
    `    _sz=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)`,
    `    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `    GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `    printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE git\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B"`,
    `    GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD"`,
    `    printf '\\n%s CONTENT_END\\n' "$B"`,
    `    return 0`,
    `  fi`,
    `  if run_with_timeout ${PROMISOR_FETCH_TIMEOUT_SECONDS} env GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always -c credential.helper= -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then`,
    `    _sz=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)`,
    `    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `    GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `    printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE git\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B"`,
    `    GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD"`,
    `    printf '\\n%s CONTENT_END\\n' "$B"`,
    `    return 0`,
    `  fi`,
    `  printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE unavailable\\n%s CONTENT_BEGIN\\n\\n%s CONTENT_END\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B" "$B"`,
    `  return 0`,
    `}`,
    `emit_repo_meta() {`,
    `  _r="$1"`,
    `  _head=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_r" rev-parse --verify HEAD 2>/dev/null || true)`,
    `  _branch=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_r" symbolic-ref --short -q HEAD 2>/dev/null || true)`,
    `  _remote=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_r" config --get remote.origin.url 2>/dev/null || true)`,
    `  _sparse_cfg=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_r" config --bool --get core.sparseCheckout 2>/dev/null || true)`,
    `  _promisor=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_r" config --get-regexp '^remote\\..*\\.promisor$' 2>/dev/null || true)`,
    `  _sparse=0`,
    `  if [ "$_sparse_cfg" = "true" ] || [ -n "$_promisor" ]; then _sparse=1; fi`,
    `  printf '%s REPO_START\\n%s ROOT %s\\n%s REMOTE %s\\n%s HEAD %s\\n%s BRANCH %s\\n%s SPARSE %s\\n%s REPO_END\\n' "$B" "$B" "$_r" "$B" "$_remote" "$B" "$_head" "$B" "$_branch" "$B" "$_sparse" "$B"`,
    `}`,
  ].join("\n");
}

function emitSpecsForRepoShell(
  repoVar: string,
  scopeExpr: string,
  specs: readonly (readonly string[])[],
  prefixVar?: string,
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  for (const candidates of specs) {
    lines.push("for _cand in " + candidates.map(shellQuote).join(" ") + "; do");
    const relExpr = prefixVar !== undefined ? `${prefixVar}$_cand` : "$_cand";
    lines.push(`  if emit_file_repo ${scopeExpr} "${repoVar}" "${relExpr}"; then break; fi`);
    lines.push("done");
  }
  return lines.join("\n");
}

function emitSpecsForDirWorktreeShell(
  dirVar: string,
  baseVar: string,
  scopeExpr: string,
  specs: readonly (readonly string[])[],
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  for (const candidates of specs) {
    lines.push("for _cand in " + candidates.map(shellQuote).join(" ") + "; do");
    lines.push(
      `  if emit_file_worktree ${scopeExpr} "${baseVar}" "$_cand" "${dirVar}/$_cand"; then break; fi`,
    );
    lines.push("done");
  }
  return lines.join("\n");
}

interface ParsedRepoMeta {
  readonly root: string;
  readonly remote: string | null;
  readonly slug: string | null;
  readonly head: string | null;
  readonly branch: string | null;
  readonly sparse: boolean;
}

interface ParsedFileEntry {
  readonly scope: string;
  readonly file: RepositoryInstructionFile;
}

interface ParsedProtocolOutput {
  readonly workspaceRoot: string | null;
  readonly homeDir: string | null;
  readonly enclosingRepoRoot: string | null;
  readonly repos: readonly ParsedRepoMeta[];
  readonly files: readonly ParsedFileEntry[];
  readonly checkedDirs: readonly string[];
}

function truncateContent(
  raw: string,
  path: string,
  maxFileBytes: number,
): { readonly content: string; readonly truncated: boolean } {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= maxFileBytes) {
    return { content: raw, truncated: false };
  }
  let end = maxFileBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const sliced = bytes.subarray(0, end).toString("utf8");
  return {
    content: `${sliced}\n\n[truncated: read ${path} for the rest]`,
    truncated: true,
  };
}

function parseProtocolOutput(
  stdout: string,
  boundary: string,
  maxFileBytes: number,
): ParsedProtocolOutput {
  let workspaceRoot: string | null = null;
  let homeDir: string | null = null;
  let enclosingRepoRoot: string | null = null;
  const repos: ParsedRepoMeta[] = [];
  const seenRepos = new Set<string>();
  const files: ParsedFileEntry[] = [];
  const checkedDirs: string[] = [];
  const seenChecked = new Set<string>();

  const prefix = `${boundary} `;
  let cursor = 0;

  function readLine(): string | null {
    if (cursor >= stdout.length) return null;
    const nl = stdout.indexOf("\n", cursor);
    if (nl === -1) {
      const line = stdout.slice(cursor);
      cursor = stdout.length;
      return line;
    }
    const line = stdout.slice(cursor, nl);
    cursor = nl + 1;
    return line;
  }

  while (cursor < stdout.length) {
    const line = readLine();
    if (line === null) break;
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);

    if (rest.startsWith("WORKSPACE ")) {
      workspaceRoot = rest.slice("WORKSPACE ".length);
      continue;
    }

    if (rest.startsWith("HOME ")) {
      const val = rest.slice("HOME ".length);
      homeDir = val.length > 0 ? val : null;
      continue;
    }

    if (rest.startsWith("ENCLOSING_ROOT ")) {
      const root = rest.slice("ENCLOSING_ROOT ".length);
      enclosingRepoRoot = root.length > 0 ? root : null;
      continue;
    }

    if (rest.startsWith("CHECKED_DIR ")) {
      const dir = rest.slice("CHECKED_DIR ".length);
      if (dir.length > 0 && !seenChecked.has(dir)) {
        seenChecked.add(dir);
        checkedDirs.push(dir);
      }
      continue;
    }

    if (rest === "REPO_START") {
      let root = "";
      let remoteRaw = "";
      let headRaw = "";
      let branchRaw = "";
      let sparseRaw = "0";
      while (cursor < stdout.length) {
        const inner = readLine();
        if (inner === null) break;
        if (!inner.startsWith(prefix)) continue;
        const field = inner.slice(prefix.length);
        if (field === "REPO_END") break;
        if (field.startsWith("ROOT ")) root = field.slice("ROOT ".length);
        else if (field.startsWith("REMOTE ")) remoteRaw = field.slice("REMOTE ".length);
        else if (field.startsWith("HEAD ")) headRaw = field.slice("HEAD ".length);
        else if (field.startsWith("BRANCH ")) branchRaw = field.slice("BRANCH ".length);
        else if (field.startsWith("SPARSE ")) sparseRaw = field.slice("SPARSE ".length);
      }
      if (root.length > 0 && !seenRepos.has(root)) {
        seenRepos.add(root);
        const sanitized = sanitizeRemoteUrl(remoteRaw);
        const remote = sanitized.length > 0 ? sanitized : null;
        const slug = remote === null ? null : parseRepositorySlug(remote);
        repos.push({
          root,
          remote,
          slug,
          head: headRaw.length > 0 ? headRaw : null,
          branch: branchRaw.length > 0 ? branchRaw : null,
          sparse: sparseRaw === "1",
        });
      }
      continue;
    }

    if (rest === "FILE_START") {
      let scope = "";
      let path = "";
      let relativePath = "";
      let source: RepositoryInstructionFile["source"] = "worktree";
      let contentRaw = "";
      while (cursor < stdout.length) {
        const inner = readLine();
        if (inner === null) break;
        if (!inner.startsWith(prefix)) continue;
        const field = inner.slice(prefix.length);
        if (field.startsWith("SCOPE ")) scope = field.slice("SCOPE ".length);
        else if (field.startsWith("PATH ")) path = field.slice("PATH ".length);
        else if (field.startsWith("REL ")) relativePath = field.slice("REL ".length);
        else if (field.startsWith("SOURCE ")) {
          const val = field.slice("SOURCE ".length);
          if (val === "worktree" || val === "git" || val === "unavailable") source = val;
        } else if (field === "CONTENT_BEGIN") {
          const endMarker = `\n${boundary} CONTENT_END`;
          const endIdx = stdout.indexOf(endMarker, cursor);
          if (endIdx === -1) {
            contentRaw = stdout.slice(cursor);
            cursor = stdout.length;
          } else {
            contentRaw = stdout.slice(cursor, endIdx);
            cursor = endIdx + endMarker.length;
            if (stdout[cursor] === "\n") cursor += 1;
          }
          break;
        }
      }
      if (path.length === 0 || relativePath.length === 0) continue;
      if (source === "unavailable") {
        files.push({
          scope,
          file: {
            path,
            relativePath,
            source: "unavailable",
            content: null,
            truncated: false,
          },
        });
      } else {
        if (contentRaw.trim() === "") continue;
        const { content, truncated } = truncateContent(contentRaw, path, maxFileBytes);
        files.push({
          scope,
          file: {
            path,
            relativePath,
            source,
            content,
            truncated,
          },
        });
      }
    }
  }

  return { workspaceRoot, homeDir, enclosingRepoRoot, repos, files, checkedDirs };
}

function attachInstructions(
  repos: readonly ParsedRepoMeta[],
  files: readonly ParsedFileEntry[],
): readonly DiscoveredRepository[] {
  const byRepo = new Map<string, RepositoryInstructionFile[]>();
  for (const entry of files) {
    if (!entry.scope.startsWith("repo:")) continue;
    const root = entry.scope.slice("repo:".length);
    const list = byRepo.get(root) ?? [];
    list.push(entry.file);
    byRepo.set(root, list);
  }
  return repos.map((repo) => ({
    ...repo,
    instructions: byRepo.get(repo.root) ?? [],
  }));
}

export async function discoverWorkspace(
  sandbox: RepositorySandbox,
  options: DiscoverRepositoriesOptions & {
    readonly includeWorkspaceInstructions?: boolean;
    readonly extraPaths?: readonly string[];
    readonly existingRoots?: readonly string[];
  } = {},
): Promise<WorkspaceDiscoveryResult> {
  const roots = validateRoots(options.roots);
  const specs = validateInstructionSpecs(options.instructions);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const includeWorkspaceInstructions = options.includeWorkspaceInstructions ?? false;
  const extraPaths = options.extraPaths ?? [];
  const existingRoots = options.existingRoots ?? [];

  const boundary = createBoundary();
  const workspacePath = sandbox.resolvePath(".");
  const resolvedRoots = roots.map((root) => sandbox.resolvePath(root));
  const quotedRoots = resolvedRoots.map(shellQuote).join(" ");

  const extraPathLines = extraPaths.map((extra) =>
    [
      `_extra=${shellResolveTargetExpr(sandbox, extra)}`,
      `if [ -d "$_extra" ]; then printf '%s\\n' "$_extra"; elif [ -d "$(dirname -- "$_extra")" ]; then printf '%s\\n' "$(dirname -- "$_extra")"; fi`,
    ].join("\n"),
  );

  const existingRootLines = existingRoots.map(
    (existing) =>
      `_er=${shellQuote(existing)}; if [ -e "$_er/.git" ]; then printf '%s\\n' "$_er"; fi`,
  );

  const script = [
    shellHelpers(boundary, maxFileBytes),
    `WS=$(canon_path ${shellQuote(workspacePath)} 2>/dev/null || printf '%s' ${shellQuote(workspacePath)})`,
    `printf '%s WORKSPACE %s\\n' "$B" "$WS"`,
    `if [ -n "\${HOME:-}" ] && [ -d "$HOME" ]; then _hr=$(canon_path "$HOME" 2>/dev/null || printf '%s' "$HOME"); printf '%s HOME %s\\n' "$B" "$_hr"; fi`,
    `NL='`,
    `'`,
    `SEEN="$NL"`,
    `{`,
    `  for _scan_root in ${quotedRoots}; do`,
    `    [ -d "$_scan_root" ] || continue`,
    `    _scan_real=$(canon_path "$_scan_root" 2>/dev/null || true)`,
    `    [ -n "$_scan_real" ] || continue`,
    `    find "$_scan_real" -maxdepth 4 \\`,
    `      \\( -name node_modules -o -name .next -o -name dist -o -name build -o -name .turbo -o -name target -o -name vendor -o -name .venv -o -name __pycache__ \\) -prune \\`,
    `      -o -name .git \\( -type d -o -type f \\) -print -prune 2>/dev/null | while IFS= read -r _git_entry; do`,
    `      [ -n "$_git_entry" ] || continue`,
    `      dirname -- "$_git_entry"`,
    `    done`,
    `  done`,
    ...extraPathLines.map((line) => `  ${line}`),
    ...existingRootLines.map((line) => `  ${line}`),
    `} | while IFS= read -r _cand_dir; do`,
    `  [ -n "$_cand_dir" ] || continue`,
    `  [ -d "$_cand_dir" ] || continue`,
    `  _top=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_cand_dir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `  [ -n "$_top" ] || continue`,
    `  _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `  [ -n "$_repo_real" ] || continue`,
    `  case "$SEEN" in *"$NL$_repo_real$NL"*) continue ;; esac`,
    `  SEEN="$SEEN$_repo_real$NL"`,
    `  emit_repo_meta "$_repo_real"`,
    emitSpecsForRepoShell("$_repo_real", '"repo:$_repo_real"', specs),
    `done`,
    ...(includeWorkspaceInstructions && specs.length > 0
      ? [
          `if [ ! -e "$WS/.git" ]; then`,
          emitSpecsForDirWorktreeShell("$WS", "$WS", '"workspace"', specs),
          `fi`,
        ]
      : []),
    `exit 0`,
  ].join("\n");

  const result = await sandbox.run({ command: script });
  if (result.exitCode !== 0) {
    throw new Error(`Could not discover repositories: ${commandFailureDetail(result)}`);
  }

  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  const repositories = attachInstructions(parsed.repos, parsed.files);
  const workspaceRoot = parsed.workspaceRoot ?? workspacePath;
  const workspaceCoveredByRepo = repositories.some((repo) =>
    repo.root === "/"
      ? workspaceRoot.startsWith("/")
      : workspaceRoot === repo.root || workspaceRoot.startsWith(`${repo.root}/`),
  );
  const workspaceInstructions = workspaceCoveredByRepo
    ? []
    : parsed.files.filter((entry) => entry.scope === "workspace").map((entry) => entry.file);

  return {
    workspaceRoot,
    homeDir: parsed.homeDir,
    repositories,
    workspaceInstructions,
  };
}

/**
 * Discovers git repositories under the configured workspace roots (up to depth 3, handling standard clones, worktrees, and submodules)
 * and loads their default instruction files in a single sandbox command.
 */
export async function discoverRepositories(
  sandbox: RepositorySandbox,
  options: DiscoverRepositoriesOptions = {},
): Promise<readonly DiscoveredRepository[]> {
  const result = await discoverWorkspace(sandbox, {
    ...options,
    includeWorkspaceInstructions: false,
  });
  return result.repositories;
}

/**
 * Reads a single repository-relative file from the worktree with fallback to `HEAD:<relativePath>`,
 * enforcing strict relative path validation, symlink containment inside `repoRoot`, and the byte cap.
 */
export async function readRepositoryFile(
  sandbox: RepositorySandbox,
  repoRoot: string,
  relativePath: string,
  options: ReadRepositoryFileOptions = {},
): Promise<RepositoryInstructionFile | null> {
  if (!isValidRelativePath(relativePath)) {
    throw new Error(
      `Invalid repository relative path ${JSON.stringify(relativePath)}: must be a relative POSIX path without traversal or control characters.`,
    );
  }
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const boundary = createBoundary();
  const resolvedRoot = sandbox.resolvePath(repoRoot);

  const script = [
    shellHelpers(boundary, maxFileBytes),
    `_repo_real=$(canon_path ${shellQuote(resolvedRoot)} 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    `emit_file_repo "single" "$_repo_real" ${shellQuote(relativePath)} || true`,
    `exit 0`,
  ].join("\n");

  const result = await sandbox.run({ command: script });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read repository file: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  return parsed.files[0]?.file ?? null;
}

export async function readRepositorySpecFiles(
  sandbox: RepositorySandbox,
  repoRoot: string,
  specs: readonly RepositoryInstructionSpec[],
  options: ReadRepositoryFileOptions = {},
): Promise<readonly RepositoryInstructionFile[]> {
  const normalized = normalizeSpecs(specs);
  if (normalized.length === 0) return [];
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const boundary = createBoundary();
  const resolvedRoot = sandbox.resolvePath(repoRoot);

  const script = [
    shellHelpers(boundary, maxFileBytes),
    `_repo_real=$(canon_path ${shellQuote(resolvedRoot)} 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    emitSpecsForRepoShell("$_repo_real", '"repo:$_repo_real"', normalized),
    `exit 0`,
  ].join("\n");

  const result = await sandbox.run({ command: script });
  if (result.exitCode !== 0) {
    throw new Error(`Could not read repository instruction files: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  return parsed.files.map((entry) => entry.file);
}

export async function findEnclosingRepository(
  sandbox: RepositorySandbox,
  targetPath: string,
  options: Pick<DiscoverRepositoriesOptions, "instructions" | "maxFileBytes"> = {},
): Promise<DiscoveredRepository | null> {
  const specs = normalizeSpecs(options.instructions ?? DEFAULT_REPOSITORY_INSTRUCTIONS);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const boundary = createBoundary();

  const script = [
    shellHelpers(boundary, maxFileBytes),
    `_target=${shellResolveTargetExpr(sandbox, targetPath)}`,
    `if [ -d "$_target" ]; then _dir="$_target"; else _dir=$(dirname -- "$_target"); fi`,
    `[ -d "$_dir" ] || exit 0`,
    `_top=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_dir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `[ -n "$_top" ] || exit 0`,
    `_repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    `emit_repo_meta "$_repo_real"`,
    emitSpecsForRepoShell("$_repo_real", '"repo:$_repo_real"', specs),
    `exit 0`,
  ].join("\n");

  const result = await sandbox.run({ command: script });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect enclosing repository: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  const repositories = attachInstructions(parsed.repos, parsed.files);
  return repositories[0] ?? null;
}

export function computeAncestorDirs(rootDir: string, targetDir: string): readonly string[] {
  const root = posix.resolve("/", rootDir);
  const target = posix.resolve("/", targetDir);
  if (target === root) return [];
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!target.startsWith(prefix)) return [];
  const remainder = target.slice(prefix.length);
  if (remainder.length === 0) return [];
  const parts = remainder.split("/").filter((part) => part.length > 0);
  const dirs: string[] = [];
  let current = root;
  for (const part of parts) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    dirs.push(current);
  }
  return dirs;
}

export async function readScopedDirectoryInstructions(
  sandbox: RepositorySandbox,
  options: {
    readonly targetPath: string;
    readonly checkedDirs: ReadonlySet<string>;
    readonly knownRepoRoots?: ReadonlySet<string>;
    readonly instructions?: readonly RepositoryInstructionSpec[];
    readonly maxFileBytes?: number;
    readonly loadScoped?: boolean;
  },
): Promise<ScopedProbeResult> {
  const specs = normalizeSpecs(options.instructions ?? DEFAULT_REPOSITORY_INSTRUCTIONS);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const loadScoped = options.loadScoped ?? true;
  const boundary = createBoundary();
  const workspacePath = sandbox.resolvePath(".");
  const checkedList = [...options.checkedDirs];
  const knownRoots = [...(options.knownRepoRoots ?? [])];

  const checkedCase =
    checkedList.length === 0
      ? "false"
      : `case "$_d" in ${checkedList.map(shellQuote).join("|")}) true ;; *) false ;; esac`;
  const knownRepoCase =
    knownRoots.length === 0
      ? "false"
      : `case "$_repo_real" in ${knownRoots.map(shellQuote).join("|")}) true ;; *) false ;; esac`;

  const script = [
    shellHelpers(boundary, maxFileBytes),
    `WS=$(canon_path ${shellQuote(workspacePath)} 2>/dev/null || printf '%s' ${shellQuote(workspacePath)})`,
    `printf '%s WORKSPACE %s\\n' "$B" "$WS"`,
    `if [ -n "\${HOME:-}" ] && [ -d "$HOME" ]; then _hr=$(canon_path "$HOME" 2>/dev/null || printf '%s' "$HOME"); printf '%s HOME %s\\n' "$B" "$_hr"; fi`,
    `_target=${shellResolveTargetExpr(sandbox, options.targetPath)}`,
    `if [ -d "$_target" ]; then`,
    `  _tdir=$(canon_path "$_target" 2>/dev/null || true)`,
    `else`,
    `  _tdir=$(canon_path "$(dirname -- "$_target")" 2>/dev/null || true)`,
    `fi`,
    `[ -n "$_tdir" ] || exit 0`,
    `_top=$(GIT_NO_LAZY_FETCH=1 git -c core.hooksPath=/dev/null -c protocol.allow=never -C "$_tdir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `_repo_real=""`,
    `if [ -n "$_top" ]; then`,
    `  _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `fi`,
    `if [ -n "$_repo_real" ]; then`,
    `  printf '%s ENCLOSING_ROOT %s\\n' "$B" "$_repo_real"`,
    `fi`,
    `if [ -n "$_repo_real" ] && ! ${knownRepoCase}; then`,
    `  emit_repo_meta "$_repo_real"`,
    emitSpecsForRepoShell("$_repo_real", '"repo:$_repo_real"', specs),
    `fi`,
    ...(loadScoped && specs.length > 0
      ? [
          `if [ -n "$_repo_real" ]; then _anchor="$_repo_real"; else _anchor="$WS"; fi`,
          `if path_within "$_tdir" "$_anchor"; then`,
          `  _dirs=""`,
          `  _cur="$_tdir"`,
          `  while [ "$_cur" != "$_anchor" ] && [ "$_cur" != "/" ] && [ -n "$_cur" ]; do`,
          `    _dirs="$_cur`,
          `$_dirs"`,
          `    _next=$(dirname -- "$_cur")`,
          `    [ "$_next" = "$_cur" ] && break`,
          `    _cur="$_next"`,
          `  done`,
          `  printf '%s' "$_dirs" | while IFS= read -r _d; do`,
          `    [ -n "$_d" ] || continue`,
          `    if ${checkedCase}; then continue; fi`,
          `    printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
          `    if [ -n "$_repo_real" ]; then`,
          `      if [ "$_repo_real" = "/" ]; then _rel_dir="\${_d#/}/"; else _rel_dir="\${_d#"$_repo_real"/}/"; fi`,
          emitSpecsForRepoShell("$_repo_real", '"scope:$_d"', specs, "$_rel_dir"),
          `    else`,
          emitSpecsForDirWorktreeShell("$_d", "$WS", '"scope:$_d"', specs),
          `    fi`,
          `  done`,
          `elif [ -z "$_repo_real" ] && [ "$_tdir" != "$WS" ]; then`,
          `  _d="$_tdir"`,
          `  if ! ${checkedCase}; then`,
          `    printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
          `  fi`,
          `fi`,
        ]
      : [
          `if [ -z "$_repo_real" ] && [ "$_tdir" != "$WS" ]; then`,
          `  _d="$_tdir"`,
          `  if ! ${checkedCase}; then`,
          `    printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
          `  fi`,
          `fi`,
        ]),
    `exit 0`,
  ].join("\n");

  const result = await sandbox.run({ command: script });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect scoped instructions: ${commandFailureDetail(result)}`);
  }

  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  const repositories = attachInstructions(parsed.repos, parsed.files);
  const byScope = new Map<string, RepositoryInstructionFile[]>();
  for (const entry of parsed.files) {
    if (!entry.scope.startsWith("scope:")) continue;
    const dir = entry.scope.slice("scope:".length);
    const list = byScope.get(dir) ?? [];
    list.push(entry.file);
    byScope.set(dir, list);
  }
  const scopes = parsed.checkedDirs
    .map((dir) => ({ dir, files: byScope.get(dir) ?? [] }))
    .filter((entry) => entry.files.length > 0);

  return {
    workspaceRoot: parsed.workspaceRoot ?? workspacePath,
    homeDir: parsed.homeDir,
    enclosingRepoRoot: parsed.enclosingRepoRoot,
    enclosingRepo: repositories[0] ?? null,
    checkedDirs: parsed.checkedDirs,
    scopes,
  };
}
