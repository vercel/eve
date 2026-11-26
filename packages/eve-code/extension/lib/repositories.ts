import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { SandboxCommandResult, SandboxSession } from "eve/sandbox";

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
export const MAX_DISCOVERED_REPOSITORIES = 32;
export const MAX_SCAN_CANDIDATES = 256;
export const MAX_SCAN_DIRS = 1024;
export const MAX_META_FIELD_BYTES = 2048;
export const MAX_OVERFLOW_PATHS = 64;

const MAX_STDERR_BYTES = 65_536;

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
  readonly overflowPaths: readonly string[];
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
  readonly overflowPaths: readonly string[];
}

export type RepositorySandbox = Pick<SandboxSession, "resolvePath" | "run"> &
  Partial<Pick<SandboxSession, "spawn">>;

export interface BoundedCommandResult extends SandboxCommandResult {
  readonly overflowed: boolean;
}

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
  if (value.trim().length === 0 || value.startsWith("/")) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return false;
  }
  return value.split("/").every((s) => s.length > 0 && s !== "." && s !== "..");
}

export function isValidRootPath(value: string): boolean {
  return value === "." || isValidRelativePath(value);
}

function validatePositiveInt(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} ${String(value)}: must be a positive integer.`);
  }
  return value;
}

export function computeMaxOutputBytes(maxTotalBytes: number): number {
  return Math.min(Math.max(maxTotalBytes * 2 + 131_072, 524_288), 4_194_304);
}

function decodeUtf8Bounded(bytes: Uint8Array, limit: number, trimIncomplete: boolean): string {
  const capped = bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
  return new TextDecoder("utf-8").decode(capped, { stream: trimIncomplete });
}

export async function runBoundedSandboxCommand(
  sandbox: RepositorySandbox,
  command: string,
  maxOutputBytes: number,
): Promise<BoundedCommandResult> {
  const stdoutLimit = Math.max(1, Math.floor(maxOutputBytes));
  if (typeof sandbox.spawn !== "function") {
    const res = await sandbox.run({ command });
    const outBuf = Buffer.from(res.stdout, "utf8");
    const errBuf = Buffer.from(res.stderr, "utf8");
    const outOver = outBuf.byteLength > stdoutLimit;
    const errOver = errBuf.byteLength > MAX_STDERR_BYTES;
    return {
      exitCode: res.exitCode,
      stdout: outOver ? decodeUtf8Bounded(outBuf, stdoutLimit, true) : res.stdout,
      stderr: errOver ? decodeUtf8Bounded(errBuf, MAX_STDERR_BYTES, true) : res.stderr,
      overflowed: outOver || errOver,
    };
  }

  const proc = await sandbox.spawn({ command });
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();
  let overflowed = false;
  let killPromise: Promise<void> | null = null;

  const triggerOverflow = () => {
    if (overflowed) return;
    overflowed = true;
    void stdoutReader.cancel().catch(() => undefined);
    void stderrReader.cancel().catch(() => undefined);
    killPromise = Promise.resolve(proc.kill()).catch(() => undefined);
  };

  const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>, limit: number) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength || overflowed) continue;
        const rem = limit - total;
        if (value.byteLength > rem) {
          if (rem > 0) {
            chunks.push(value.slice(0, rem));
            total += rem;
          }
          truncated = true;
          triggerOverflow();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (error) {
      if (!overflowed) throw error;
    } finally {
      reader.releaseLock();
    }
    return { bytes: Buffer.concat(chunks, total), truncated };
  };

  const [out, err] = await Promise.all([
    collect(stdoutReader, stdoutLimit),
    collect(stderrReader, MAX_STDERR_BYTES),
  ]);

  if (overflowed) {
    if (killPromise !== null) await killPromise;
    void Promise.resolve(proc.wait()).catch(() => undefined);
    return {
      exitCode: 1,
      stdout: decodeUtf8Bounded(out.bytes, stdoutLimit, out.truncated),
      stderr: decodeUtf8Bounded(err.bytes, MAX_STDERR_BYTES, err.truncated),
      overflowed: true,
    };
  }

  const { exitCode } = await proc.wait();
  return {
    exitCode,
    stdout: decodeUtf8Bounded(out.bytes, stdoutLimit, false),
    stderr: decodeUtf8Bounded(err.bytes, MAX_STDERR_BYTES, false),
    overflowed: false,
  };
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
  return (specs ?? DEFAULT_REPOSITORY_INSTRUCTIONS).map((spec) => {
    const candidates = typeof spec === "string" ? [spec] : [...spec];
    if (candidates.length === 0) {
      throw new Error("Invalid repository instruction spec: fallback tuple must not be empty.");
    }
    for (const candidate of candidates) {
      if (!isValidRelativePath(candidate)) {
        throw new Error(
          `Invalid repository instruction path ${JSON.stringify(candidate)}: must be a relative POSIX path without traversal or control characters.`,
        );
      }
    }
    return candidates;
  });
}

function normalizeSpecs(
  specs: readonly RepositoryInstructionSpec[],
): readonly (readonly string[])[] {
  return specs
    .map((spec) => (typeof spec === "string" ? [spec] : [...spec]).filter(isValidRelativePath))
    .filter((valid) => valid.length > 0);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellResolveTargetExpr(sandbox: RepositorySandbox, rawPath: string): string {
  if (rawPath === "~" || rawPath === "$HOME") return '"$HOME"';
  if (rawPath.startsWith("~/")) return `"$HOME"/${shellQuote(rawPath.slice(2))}`;
  if (rawPath.startsWith("$HOME/")) return `"$HOME"/${shellQuote(rawPath.slice(6))}`;
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
  if (scp !== null) return scp[1] === "git" ? `git@${scp[2]}:${scp[3]}` : `${scp[2]}:${scp[3]}`;
  return trimmed.replace(/[?#].*$/u, "");
}

export function parseRepositorySlug(remote: string): string | null {
  const sanitized = sanitizeRemoteUrl(remote);
  if (sanitized.length === 0 || /^file:\/\//iu.test(sanitized) || sanitized.startsWith("/")) {
    return null;
  }
  let pathPart: string | null = null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(sanitized)) {
    try {
      pathPart = new URL(sanitized).pathname;
    } catch {
      return null;
    }
  } else {
    pathPart = /^(?:[^@:/]+@)?([^:/]+):(.+)$/u.exec(sanitized)?.[2] ?? null;
  }
  if (pathPart === null) return null;
  const segments = pathPart
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  return segments.length >= 2 ? segments.join("/") : null;
}

export function matchesRepositoryRule(
  repo: DiscoveredRepository,
  match: RepositoryRule["match"],
): boolean {
  if (match === undefined || match === "*") return true;
  if (typeof match === "function") {
    try {
      return Boolean(match(repo));
    } catch (error) {
      console.warn(
        `eve-code repository rule match failed for ${repo.root}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  if (match instanceof RegExp) {
    if (repo.slug !== null) {
      match.lastIndex = 0;
      if (match.test(repo.slug)) return true;
    }
    match.lastIndex = 0;
    return match.test(repo.root);
  }
  if (repo.slug === null) return false;
  const candidate = repo.slug.toLowerCase();
  const pattern = match.toLowerCase();
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return candidate.startsWith(prefix) && candidate.length > prefix.length;
  }
  return candidate === pattern;
}

function shellHelpers(boundary: string, maxFileBytes: number, maxTotalBytes: number): string {
  const fileBytes = Math.max(1, Math.floor(maxFileBytes));
  const headBytes = fileBytes + 1;
  const totalBytes = Math.max(0, Math.floor(maxTotalBytes));
  return `B=${shellQuote(boundary)}
NL='
'
MAX_FILE=${fileBytes} MAX_HEAD=${headBytes} MAX_TOTAL_BYTES=${totalBytes}
MAX_REPOS=${MAX_DISCOVERED_REPOSITORIES} MAX_SCAN_CANDS=${MAX_SCAN_CANDIDATES} MAX_SCAN_DIRS=${MAX_SCAN_DIRS} MAX_META=${MAX_META_FIELD_BYTES} MAX_OVERFLOW=${MAX_OVERFLOW_PATHS}
REPO_COUNT=0 TOTAL_BYTES=0 BUDGET_EXHAUSTED=0 OVERFLOW_COUNT=0 _SCAN_EMITTED=0 _SCAN_VISITED=0 _repo_git_fallback=1
canon_path() {
  [ -e "$1" ] || return 1
  realpath -e -- "$1" 2>/dev/null && return 0
  realpath -- "$1" 2>/dev/null && return 0
  if [ -d "$1" ]; then (cd -P -- "$1" 2>/dev/null && pwd -P); return $?; fi
  readlink -f -- "$1" 2>/dev/null && return 0
  [ -L "$1" ] && return 1
  _cd_dir=$(cd -P -- "$(dirname -- "$1")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\\n' "$_cd_dir" "$(basename -- "$1")"
}
path_within() {
  if [ "$2" = "/" ]; then case "$1" in /*) return 0 ;; *) return 1 ;; esac; fi
  case "$1" in "$2"/*) return 0 ;; *) return 1 ;; esac
}
git_offline() {
  GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never "$@"
}
repo_allow_git() {
  _r="$1"; _sp="$2"; _repo_git_fallback=1
  [ "$_sp" = "1" ] && return 0
  if [ "$_r" = "/" ]; then _rpfx=""; else _rpfx="$_r"; fi
  for _e in "$_rpfx"/* "$_rpfx"/.[!.]* "$_rpfx"/..?*; do
    [ -e "$_e" ] || [ -L "$_e" ] || continue
    [ "\${_e##*/}" = ".git" ] && continue
    _repo_git_fallback=0; break
  done
}
scan_repos_under() {
  _level=""
  for _root in "$@"; do
    [ -d "$_root" ] || continue
    _rr=$(canon_path "$_root" 2>/dev/null || true)
    [ -n "$_rr" ] || continue
    case "\${NL}\${_level}" in *"\${NL}\${_rr}\${NL}"*) continue ;; esac
    _level="\${_level}\${_rr}\${NL}"
  done
  _depth=0
  while [ "$_depth" -le 3 ] && [ -n "$_level" ]; do
    _next_level=""; _next_count=0
    while IFS= read -r _dir; do
      [ -n "$_dir" ] || continue
      [ "$_SCAN_EMITTED" -ge "$MAX_SCAN_CANDS" ] || [ "$_SCAN_VISITED" -ge "$MAX_SCAN_DIRS" ] && return 0
      _SCAN_VISITED=$((_SCAN_VISITED + 1))
      if [ -e "$_dir/.git" ]; then _SCAN_EMITTED=$((_SCAN_EMITTED + 1)); printf '%s\\n' "$_dir"; continue; fi
      [ "$_depth" -lt 3 ] && [ "$_next_count" -lt "$MAX_SCAN_DIRS" ] || continue
      if [ "$_dir" = "/" ]; then _pfx=""; else _pfx="$_dir"; fi
      for _child in "$_pfx"/* "$_pfx"/.[!.]* "$_pfx"/..?*; do
        [ ! -L "$_child" ] && [ -d "$_child" ] || continue
        case "\${_child##*/}" in .git|node_modules|.next|dist|build|.turbo|target|vendor|.venv|__pycache__) continue ;; esac
        _next_level="\${_next_level}\${_child}\${NL}"; _next_count=$((_next_count + 1))
        [ "$_next_count" -ge "$MAX_SCAN_DIRS" ] && break
      done
    done <<${boundary}_SCAN
$_level
${boundary}_SCAN
    _level="$_next_level"; _depth=$((_depth + 1))
  done
}
emit_overflow() {
  [ "$OVERFLOW_COUNT" -lt "$MAX_OVERFLOW" ] || return 0
  OVERFLOW_COUNT=$((OVERFLOW_COUNT + 1))
  printf '%s %s %s\\n' "$B" "$1" "$(printf '%s' "$2" | tr -d '\\r\\n' | head -c "$MAX_META")"
}
consume_budget() {
  _bytes="$1"; _opath="$2"
  [ "$MAX_TOTAL_BYTES" -gt 0 ] 2>/dev/null || return 0
  [ "$_bytes" -gt "$MAX_FILE" ] 2>/dev/null && _bytes="$MAX_FILE"
  if [ "$BUDGET_EXHAUSTED" -ne 0 ] || [ $((TOTAL_BYTES + _bytes)) -gt "$MAX_TOTAL_BYTES" ]; then
    BUDGET_EXHAUSTED=1; emit_overflow "FILE_OVERFLOW" "$_opath"; return 1
  fi
  TOTAL_BYTES=$((TOTAL_BYTES + _bytes))
}
emit_file_hdr() {
  printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE %s\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$1" "$B" "$2" "$B" "$3" "$B" "$4" "$B"
}
emit_file_worktree() {
  _scope="$1"; _base="$2"; _rel="$3"; _full="$4"
  [ -f "$_full" ] && [ -s "$_full" ] || return 1
  _real=$(canon_path "$_full" 2>/dev/null || true)
  [ -n "$_real" ] && path_within "$_real" "$_base" || return 1
  head -c "$MAX_HEAD" -- "$_real" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1
  _eb=$(head -c "$MAX_HEAD" -- "$_real" | wc -c | tr -d ' \\t\\r\\n')
  [ "\${_eb:-0}" -gt 0 ] 2>/dev/null || return 1
  consume_budget "$_eb" "$_real" || return 0
  emit_file_hdr "$_scope" "$_real" "$_rel" "worktree"
  head -c "$MAX_HEAD" -- "$_real"
  printf '\\n%s CONTENT_END\\n' "$B"
}
emit_file_repo() {
  _scope="$1"; _repo="$2"; _rel="$3"; _allow_git="\${4:-1}"
  if [ "$_repo" = "/" ]; then _full="/$_rel"; else _full="$_repo/$_rel"; fi
  if [ -e "$_full" ] || [ -L "$_full" ]; then emit_file_worktree "$_scope" "$_repo" "$_rel" "$_full"; return $?; fi
  [ "$_allow_git" = "1" ] || return 1
  _ls=$(git_offline -c core.quotePath=false --literal-pathspecs -C "$_repo" ls-tree HEAD -- "$_rel" 2>/dev/null | head -n 1 || true)
  [ -n "$_ls" ] || return 1
  IFS=' \t' read -r _mode _kind _oid _rest <<${boundary}_LS
$_ls
${boundary}_LS
  [ "$_kind" = "blob" ] && { [ "$_mode" = "100644" ] || [ "$_mode" = "100755" ]; } && [ -n "$_oid" ] || return 1
  if git_offline -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then
    _sz=$(git_offline -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)
    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1
    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1
    _eb="$_sz"; [ "$_eb" -gt "$MAX_HEAD" ] 2>/dev/null && _eb="$MAX_HEAD"
    consume_budget "$_eb" "$_full" || return 0
    emit_file_hdr "$_scope" "$_full" "$_rel" "git"
    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD"
    printf '\\n%s CONTENT_END\\n' "$B"
    return 0
  fi
  if [ "$MAX_TOTAL_BYTES" -gt 0 ] 2>/dev/null && [ "$BUDGET_EXHAUSTED" -ne 0 ]; then emit_overflow "FILE_OVERFLOW" "$_full"; return 0; fi
  emit_file_hdr "$_scope" "$_full" "$_rel" "unavailable"
  printf '\\n%s CONTENT_END\\n' "$B"
}
emit_repo_meta() {
  _r="$1"
  _head=$(git_offline -C "$_r" rev-parse --verify HEAD 2>/dev/null | tr -d '\\r\\n' | head -c "$MAX_META" || true)
  _branch=$(git_offline -C "$_r" symbolic-ref --short -q HEAD 2>/dev/null | tr -d '\\r\\n' | head -c "$MAX_META" || true)
  _remote=""; _sparse_cfg=0; _promisor=0
  _cfg_out=$(git_offline -C "$_r" config --get-regexp '^(remote\\.origin\\.url|core\\.sparsecheckout|remote\\..*\\.promisor)$' 2>/dev/null | head -c 65536 || true)
  if [ -n "$_cfg_out" ]; then
    while IFS= read -r _cl; do
      [ -n "$_cl" ] || continue
      _k="\${_cl%% *}"; if [ "$_k" = "$_cl" ]; then _v=""; else _v="\${_cl#* }"; fi
      case "$_k" in
        remote.origin.url) _remote="$_v" ;;
        core.sparsecheckout) case "$_v" in ""|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]|1) _sparse_cfg=1 ;; *) _sparse_cfg=0 ;; esac ;;
        remote.*.promisor) case "$_v" in [Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]|[Oo][Ff][Ff]|0) ;; *) _promisor=1 ;; esac ;;
      esac
    done <<${boundary}_CFG
$_cfg_out
${boundary}_CFG
  fi
  [ -n "$_remote" ] && _remote=$(printf '%s' "$_remote" | tr -d '\\r\\n' | head -c "$MAX_META")
  _sparse=0; { [ "$_sparse_cfg" = "1" ] || [ "$_promisor" = "1" ]; } && _sparse=1
  repo_allow_git "$_r" "$_sparse"
  _r_out=$(printf '%s' "$_r" | tr -d '\\r\\n' | head -c "$MAX_META")
  printf '%s REPO_START\\n%s ROOT %s\\n%s REMOTE %s\\n%s HEAD %s\\n%s BRANCH %s\\n%s SPARSE %s\\n%s REPO_END\\n' "$B" "$B" "$_r_out" "$B" "$_remote" "$B" "$_head" "$B" "$_branch" "$B" "$_sparse" "$B"
}`;
}

function emitSpecsShell(
  specs: readonly (readonly string[])[],
  callForCandidate: (candExpr: string) => string,
): string {
  return specs
    .map(
      (candidates) =>
        `for _cand in ${candidates.map(shellQuote).join(" ")}; do ${callForCandidate("$_cand")} && break; done`,
    )
    .join("\n");
}

function truncateContent(raw: string, path: string, maxFileBytes: number) {
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.length <= maxFileBytes) return { content: raw, truncated: false };
  const sliced = new TextDecoder("utf-8").decode(bytes.subarray(0, maxFileBytes), { stream: true });
  return {
    content: `${sliced}\n\n[truncated: read ${path} for the rest]`,
    truncated: true,
  };
}

function parseProtocolOutput(stdout: string, boundary: string, maxFileBytes: number) {
  let workspaceRoot: string | null = null;
  let homeDir: string | null = null;
  let enclosingRepoRoot: string | null = null;
  const repos: Omit<DiscoveredRepository, "instructions">[] = [];
  const seenRepos = new Set<string>();
  const files: { readonly scope: string; readonly file: RepositoryInstructionFile }[] = [];
  const checkedDirs: string[] = [];
  const overflowPaths: string[] = [];

  const pushOverflow = (p: string) => {
    if (p.length > 0 && !overflowPaths.includes(p) && overflowPaths.length < MAX_OVERFLOW_PATHS) {
      overflowPaths.push(p);
    }
  };

  const prefix = `${boundary} `;
  let cursor = 0;
  const nextField = (): string | null => {
    while (cursor < stdout.length) {
      const nl = stdout.indexOf("\n", cursor);
      const raw = nl === -1 ? stdout.slice(cursor) : stdout.slice(cursor, nl);
      cursor = nl === -1 ? stdout.length : nl + 1;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return null;
  };

  for (let rest = nextField(); rest !== null; rest = nextField()) {
    if (rest.startsWith("WORKSPACE ")) workspaceRoot = rest.slice(10);
    else if (rest.startsWith("HOME ")) homeDir = rest.slice(5) || null;
    else if (rest.startsWith("ENCLOSING_ROOT ")) enclosingRepoRoot = rest.slice(15) || null;
    else if (rest.startsWith("CHECKED_DIR ")) {
      const dir = rest.slice(12);
      if (dir.length > 0 && !checkedDirs.includes(dir)) checkedDirs.push(dir);
    } else if (rest.startsWith("REPO_OVERFLOW ") || rest.startsWith("FILE_OVERFLOW ")) {
      pushOverflow(rest.slice(14));
    } else if (rest === "REPO_START") {
      const fields: Record<string, string> = {};
      let ended = false;
      for (let f = nextField(); f !== null; f = nextField()) {
        if (f === "REPO_END") {
          ended = true;
          break;
        }
        const sp = f.indexOf(" ");
        if (sp > 0) fields[f.slice(0, sp)] = f.slice(sp + 1);
      }
      const root = fields.ROOT ?? "";
      if (ended && root.length > 0 && !seenRepos.has(root)) {
        seenRepos.add(root);
        if (repos.length >= MAX_DISCOVERED_REPOSITORIES) pushOverflow(root);
        else {
          const remote = sanitizeRemoteUrl(fields.REMOTE ?? "") || null;
          repos.push({
            root,
            remote,
            slug: remote === null ? null : parseRepositorySlug(remote),
            head: fields.HEAD || null,
            branch: fields.BRANCH || null,
            sparse: fields.SPARSE === "1",
          });
        }
      }
    } else if (rest === "FILE_START") {
      const fields: Record<string, string> = {};
      let contentRaw = "";
      let complete = false;
      for (let f = nextField(); f !== null; f = nextField()) {
        if (f === "CONTENT_BEGIN") {
          const endMarker = `\n${boundary} CONTENT_END`;
          const endIdx = stdout.indexOf(endMarker, cursor);
          if (endIdx === -1) {
            contentRaw = stdout.slice(cursor);
            cursor = stdout.length;
          } else {
            contentRaw = stdout.slice(cursor, endIdx);
            complete = true;
            cursor = endIdx + endMarker.length;
            if (stdout[cursor] === "\r") cursor += 1;
            if (stdout[cursor] === "\n") cursor += 1;
          }
          break;
        }
        const sp = f.indexOf(" ");
        if (sp > 0) fields[f.slice(0, sp)] = f.slice(sp + 1);
      }
      const path = fields.PATH ?? "";
      const relativePath = fields.REL ?? "";
      const rawSource = fields.SOURCE;
      const source: RepositoryInstructionFile["source"] =
        rawSource === "git" || rawSource === "unavailable" ? rawSource : "worktree";
      if (path.length === 0 || relativePath.length === 0) continue;
      if (!complete) {
        pushOverflow(path);
      } else if (source === "unavailable") {
        files.push({
          scope: fields.SCOPE ?? "",
          file: { path, relativePath, source: "unavailable", content: null, truncated: false },
        });
      } else if (contentRaw.trim() !== "") {
        const { content, truncated } = truncateContent(contentRaw, path, maxFileBytes);
        files.push({
          scope: fields.SCOPE ?? "",
          file: { path, relativePath, source, content, truncated },
        });
      }
    }
  }

  return { workspaceRoot, homeDir, enclosingRepoRoot, repos, files, checkedDirs, overflowPaths };
}

function attachInstructions(
  repos: readonly Omit<DiscoveredRepository, "instructions">[],
  files: readonly { readonly scope: string; readonly file: RepositoryInstructionFile }[],
): readonly DiscoveredRepository[] {
  const byRepo = new Map<string, RepositoryInstructionFile[]>();
  for (const { scope, file } of files) {
    if (!scope.startsWith("repo:")) continue;
    const root = scope.slice(5);
    const list = byRepo.get(root) ?? [];
    list.push(file);
    byRepo.set(root, list);
  }
  return repos.map((repo) => ({ ...repo, instructions: byRepo.get(repo.root) ?? [] }));
}

async function runProtocolScript(
  sandbox: RepositorySandbox,
  buildBody: (boundary: string) => string,
  options: {
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly outputBudget: number;
    readonly errorLabel: string;
  },
) {
  const boundary = `__EVE_REPO_${randomBytes(12).toString("hex")}__`;
  const script = `${shellHelpers(boundary, options.maxFileBytes, options.maxTotalBytes)}\n${buildBody(boundary)}\nexit 0`;
  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(options.outputBudget),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
    throw new Error(`${options.errorLabel}: ${commandFailureDetail(result)}`);
  }
  return parseProtocolOutput(result.stdout, boundary, options.maxFileBytes);
}

export async function discoverWorkspace(
  sandbox: RepositorySandbox,
  options: DiscoverRepositoriesOptions & {
    readonly maxTotalBytes?: number;
    readonly includeWorkspaceInstructions?: boolean;
    readonly extraPaths?: readonly string[];
    readonly existingRoots?: readonly string[];
  } = {},
): Promise<WorkspaceDiscoveryResult> {
  const roots = validateRoots(options.roots);
  const specs = validateInstructionSpecs(options.instructions);
  const maxFileBytes = validatePositiveInt(
    options.maxFileBytes,
    "maxFileBytes",
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = validatePositiveInt(
    options.maxTotalBytes,
    "maxTotalBytes",
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const workspacePath = sandbox.resolvePath(".");
  const resolvedRoots = roots.map((root) => sandbox.resolvePath(root));

  const parsed = await runProtocolScript(
    sandbox,
    (boundary) =>
      [
        `WS=$(canon_path ${shellQuote(workspacePath)} 2>/dev/null || printf '%s' ${shellQuote(workspacePath)})`,
        `printf '%s WORKSPACE %s\\n' "$B" "$WS"`,
        `[ -n "\${HOME:-}" ] && [ -d "$HOME" ] && printf '%s HOME %s\\n' "$B" "$(canon_path "$HOME" 2>/dev/null || printf '%s' "$HOME")"`,
        `SEEN="$NL"`,
        `_cand_list=$( {`,
        ...(options.existingRoots ?? []).map(
          (r) => `_er=${shellQuote(r)}; [ -e "$_er/.git" ] && printf '%s\\n' "$_er"`,
        ),
        ...(options.extraPaths ?? []).map(
          (p) =>
            `_extra=${shellResolveTargetExpr(sandbox, p)}; if [ -d "$_extra" ]; then printf '%s\\n' "$_extra"; elif [ -d "$(dirname -- "$_extra")" ]; then printf '%s\\n' "$(dirname -- "$_extra")"; fi`,
        ),
        ...(resolvedRoots.length > 0
          ? [`scan_repos_under ${resolvedRoots.map(shellQuote).join(" ")}`]
          : []),
        `} | head -n ${MAX_SCAN_CANDIDATES} )`,
        `if [ -n "$_cand_list" ]; then`,
        `  while IFS= read -r _cand_dir; do`,
        `    [ -d "$_cand_dir" ] || continue`,
        `    _top=$(git_offline -C "$_cand_dir" rev-parse --show-toplevel 2>/dev/null || true)`,
        `    [ -n "$_top" ] || continue`,
        `    _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
        `    [ -n "$_repo_real" ] || continue`,
        `    case "$SEEN" in *"$NL$_repo_real$NL"*) continue ;; esac`,
        `    SEEN="$SEEN$_repo_real$NL"`,
        `    if [ "$REPO_COUNT" -ge "$MAX_REPOS" ]; then emit_overflow "REPO_OVERFLOW" "$_repo_real"; continue; fi`,
        `    REPO_COUNT=$((REPO_COUNT + 1))`,
        `    emit_repo_meta "$_repo_real"`,
        emitSpecsShell(
          specs,
          (c) => `emit_file_repo "repo:$_repo_real" "$_repo_real" "${c}" "$_repo_git_fallback"`,
        ),
        `  done <<${boundary}_CANDS`,
        `$_cand_list`,
        `${boundary}_CANDS`,
        `fi`,
        ...(options.includeWorkspaceInstructions && specs.length > 0
          ? [
              `if [ ! -e "$WS/.git" ]; then`,
              emitSpecsShell(
                specs,
                (c) => `emit_file_worktree "workspace" "$WS" "${c}" "$WS/${c}"`,
              ),
              `fi`,
            ]
          : []),
      ].join("\n"),
    {
      maxFileBytes,
      maxTotalBytes,
      outputBudget: maxTotalBytes,
      errorLabel: "Could not discover repositories",
    },
  );

  const repositories = attachInstructions(parsed.repos, parsed.files);
  const workspaceRoot = parsed.workspaceRoot ?? workspacePath;
  const workspaceCovered = repositories.some((repo) =>
    repo.root === "/"
      ? workspaceRoot.startsWith("/")
      : workspaceRoot === repo.root || workspaceRoot.startsWith(`${repo.root}/`),
  );
  return {
    workspaceRoot,
    homeDir: parsed.homeDir,
    repositories,
    workspaceInstructions: workspaceCovered
      ? []
      : parsed.files.filter((e) => e.scope === "workspace").map((e) => e.file),
    overflowPaths: parsed.overflowPaths,
  };
}

/**
 * Discovers git repositories under the configured workspace roots by scanning breadth-first up to depth 3
 * and stopping at each repository boundary (nested submodules are discovered when touched or listed in `roots`),
 * loading their default instruction files in a single sandbox command.
 */
export async function discoverRepositories(
  sandbox: RepositorySandbox,
  options: DiscoverRepositoriesOptions = {},
): Promise<readonly DiscoveredRepository[]> {
  return (await discoverWorkspace(sandbox, { ...options, includeWorkspaceInstructions: false }))
    .repositories;
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
  const maxFileBytes = validatePositiveInt(
    options.maxFileBytes,
    "maxFileBytes",
    DEFAULT_MAX_FILE_BYTES,
  );
  const parsed = await runProtocolScript(
    sandbox,
    () =>
      [
        `_repo_real=$(canon_path ${shellQuote(sandbox.resolvePath(repoRoot))} 2>/dev/null || true)`,
        `[ -n "$_repo_real" ] || exit 0`,
        `emit_file_repo "single" "$_repo_real" ${shellQuote(relativePath)} || true`,
      ].join("\n"),
    {
      maxFileBytes,
      maxTotalBytes: 0,
      outputBudget: maxFileBytes,
      errorLabel: "Could not read repository file",
    },
  );
  return parsed.files[0]?.file ?? null;
}

export async function readRepositorySpecFiles(
  sandbox: RepositorySandbox,
  repoRoot: string,
  specs: readonly RepositoryInstructionSpec[],
  options: ReadRepositoryFileOptions & {
    readonly maxTotalBytes?: number;
    readonly sparse?: boolean;
  } = {},
): Promise<{
  readonly files: readonly RepositoryInstructionFile[];
  readonly overflowPaths: readonly string[];
}> {
  const normalized = normalizeSpecs(specs);
  if (normalized.length === 0) return { files: [], overflowPaths: [] };
  const maxFileBytes = validatePositiveInt(
    options.maxFileBytes,
    "maxFileBytes",
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = validatePositiveInt(
    options.maxTotalBytes,
    "maxTotalBytes",
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const parsed = await runProtocolScript(
    sandbox,
    () =>
      [
        `_repo_real=$(canon_path ${shellQuote(sandbox.resolvePath(repoRoot))} 2>/dev/null || true)`,
        `[ -n "$_repo_real" ] || exit 0`,
        `repo_allow_git "$_repo_real" ${options.sparse === true ? "1" : "0"}`,
        emitSpecsShell(
          normalized,
          (c) => `emit_file_repo "repo:$_repo_real" "$_repo_real" "${c}" "$_repo_git_fallback"`,
        ),
      ].join("\n"),
    {
      maxFileBytes,
      maxTotalBytes,
      outputBudget: maxTotalBytes,
      errorLabel: "Could not read repository instruction files",
    },
  );
  return { files: parsed.files.map((e) => e.file), overflowPaths: parsed.overflowPaths };
}

export function computeAncestorDirs(rootDir: string, targetDir: string): readonly string[] {
  const root = posix.resolve("/", rootDir);
  const target = posix.resolve("/", targetDir);
  if (target === root) return [];
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!target.startsWith(prefix)) return [];
  const dirs: string[] = [];
  let current = root;
  for (const part of target.slice(prefix.length).split("/").filter(Boolean)) {
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
    readonly sparseRepoRoots?: ReadonlySet<string>;
    readonly instructions?: readonly RepositoryInstructionSpec[];
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly loadScoped?: boolean;
  },
): Promise<ScopedProbeResult> {
  const specs = normalizeSpecs(options.instructions ?? DEFAULT_REPOSITORY_INSTRUCTIONS);
  const maxFileBytes = validatePositiveInt(
    options.maxFileBytes,
    "maxFileBytes",
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = validatePositiveInt(
    options.maxTotalBytes,
    "maxTotalBytes",
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const workspacePath = sandbox.resolvePath(".");
  const caseMatch = (varName: string, values: readonly string[]) =>
    values.length === 0
      ? "false"
      : `case "${varName}" in ${values.map(shellQuote).join("|")}) true ;; *) false ;; esac`;
  const checkedCase = caseMatch("$_d", [...options.checkedDirs]);
  const knownRepoCase = caseMatch("$_repo_real", [...(options.knownRepoRoots ?? [])]);
  const sparseRepoCase =
    options.sparseRepoRoots === undefined
      ? "true"
      : caseMatch("$_repo_real", [...options.sparseRepoRoots]);

  const parsed = await runProtocolScript(
    sandbox,
    (boundary) =>
      [
        `WS=$(canon_path ${shellQuote(workspacePath)} 2>/dev/null || printf '%s' ${shellQuote(workspacePath)})`,
        `printf '%s WORKSPACE %s\\n' "$B" "$WS"`,
        `[ -n "\${HOME:-}" ] && [ -d "$HOME" ] && printf '%s HOME %s\\n' "$B" "$(canon_path "$HOME" 2>/dev/null || printf '%s' "$HOME")"`,
        `_target=${shellResolveTargetExpr(sandbox, options.targetPath)}`,
        `if [ -d "$_target" ]; then _tdir=$(canon_path "$_target" 2>/dev/null || true); else _tdir=$(canon_path "$(dirname -- "$_target")" 2>/dev/null || true); fi`,
        `[ -n "$_tdir" ] || exit 0`,
        `_top=$(git_offline -C "$_tdir" rev-parse --show-toplevel 2>/dev/null || true)`,
        `_repo_real=""; [ -n "$_top" ] && _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
        `if [ -n "$_repo_real" ]; then`,
        `  _rp=$(git_offline -C "$_tdir" rev-parse --show-prefix 2>/dev/null | tr -d '\\r' || true); _rp="\${_rp%/}"`,
        `  if [ -n "$_rp" ]; then if [ "$_repo_real" = "/" ]; then _tdir="/$_rp"; else _tdir="$_repo_real/$_rp"; fi; else _tdir="$_repo_real"; fi`,
        `  printf '%s ENCLOSING_ROOT %s\\n' "$B" "$_repo_real"`,
        `fi`,
        `_scope_allow_git=1`,
        `if [ -n "$_repo_real" ] && ! ${knownRepoCase}; then`,
        `  emit_repo_meta "$_repo_real"; _scope_allow_git="$_repo_git_fallback"`,
        emitSpecsShell(
          specs,
          (c) => `emit_file_repo "repo:$_repo_real" "$_repo_real" "${c}" "$_repo_git_fallback"`,
        ),
        `elif [ -n "$_repo_real" ] && ! ${sparseRepoCase}; then`,
        `  _scope_allow_git=0`,
        `fi`,
        ...((options.loadScoped ?? true) && specs.length > 0
          ? [
              `if [ -n "$_repo_real" ]; then _anchor="$_repo_real"; else _anchor="$WS"; fi`,
              `if path_within "$_tdir" "$_anchor"; then`,
              `  _dirs=""; _cur="$_tdir"`,
              `  while [ "$_cur" != "$_anchor" ] && [ "$_cur" != "/" ] && [ -n "$_cur" ]; do`,
              `    _dirs="$_cur\n$_dirs"; _next=$(dirname -- "$_cur"); [ "$_next" = "$_cur" ] && break; _cur="$_next"`,
              `  done`,
              `  if [ -n "$_dirs" ]; then`,
              `    while IFS= read -r _d; do`,
              `      [ -n "$_d" ] || continue`,
              `      ${checkedCase} && continue`,
              `      printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
              `      if [ -n "$_repo_real" ]; then`,
              `        if [ "$_repo_real" = "/" ]; then _rel_dir="\${_d#/}/"; else _rel_dir="\${_d#"$_repo_real"/}/"; fi`,
              emitSpecsShell(
                specs,
                (c) =>
                  `emit_file_repo "scope:$_d" "$_repo_real" "$_rel_dir${c}" "$_scope_allow_git"`,
              ),
              `      else`,
              emitSpecsShell(
                specs,
                (c) => `emit_file_worktree "scope:$_d" "$WS" "${c}" "$_d/${c}"`,
              ),
              `      fi`,
              `    done <<${boundary}_DIRS`,
              `$_dirs`,
              `${boundary}_DIRS`,
              `  fi`,
              `elif [ -z "$_repo_real" ] && [ "$_tdir" != "$WS" ]; then`,
              `  _d="$_tdir"; ${checkedCase} || printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
              `fi`,
            ]
          : [
              `if [ -z "$_repo_real" ] && [ "$_tdir" != "$WS" ]; then`,
              `  _d="$_tdir"; ${checkedCase} || printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
              `fi`,
            ]),
      ].join("\n"),
    {
      maxFileBytes,
      maxTotalBytes,
      outputBudget: maxTotalBytes,
      errorLabel: "Could not inspect scoped instructions",
    },
  );

  const byScope = new Map<string, RepositoryInstructionFile[]>();
  for (const { scope, file } of parsed.files) {
    if (!scope.startsWith("scope:")) continue;
    const dir = scope.slice(6);
    const list = byScope.get(dir) ?? [];
    list.push(file);
    byScope.set(dir, list);
  }
  return {
    workspaceRoot: parsed.workspaceRoot ?? workspacePath,
    homeDir: parsed.homeDir,
    enclosingRepoRoot: parsed.enclosingRepoRoot,
    enclosingRepo: attachInstructions(parsed.repos, parsed.files)[0] ?? null,
    checkedDirs: parsed.checkedDirs,
    scopes: parsed.checkedDirs
      .map((dir) => ({ dir, files: byScope.get(dir) ?? [] }))
      .filter((e) => e.files.length > 0),
    overflowPaths: parsed.overflowPaths,
  };
}
