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
  readonly finishedJobDirs: readonly string[];
  readonly overflowPaths: readonly string[];
  readonly unchangedFileRoots: ReadonlySet<string>;
  readonly unchangedRuleFileRoots: ReadonlySet<string>;
  readonly fileFingerprints: Readonly<Record<string, string>>;
}

export interface ScopedProbeResult {
  readonly workspaceRoot: string;
  readonly homeDir: string | null;
  readonly enclosingRepoRoot: string | null;
  readonly enclosingRepo: DiscoveredRepository | null;
  readonly enclosingRepoFingerprint?: string;
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

function hasControlOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

export function isValidRelativePath(value: string): boolean {
  if (value.trim().length === 0) return false;
  if (value.startsWith("/") || hasControlOrBackslash(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isValidRootPath(value: string): boolean {
  return value === "." || isValidRelativePath(value);
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/u.test(value);
}

export function normalizePlatformPath(value: string): string {
  const slashed = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//u.test(slashed)) {
    const drive = slashed.slice(0, 2);
    const rest = posix.resolve("/", slashed.slice(2));
    return `${drive}${rest}`;
  }
  if (slashed.startsWith("/")) {
    return posix.resolve("/", slashed);
  }
  return posix.normalize(slashed);
}

function validateMaxFileBytes(maxFileBytes: number | undefined): number {
  if (maxFileBytes === undefined) return DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error(`Invalid maxFileBytes ${String(maxFileBytes)}: must be a positive integer.`);
  }
  return maxFileBytes;
}

function validateMaxTotalBytes(maxTotalBytes: number | undefined): number {
  if (maxTotalBytes === undefined) return DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error(`Invalid maxTotalBytes ${String(maxTotalBytes)}: must be a positive integer.`);
  }
  return maxTotalBytes;
}

export function computeMaxOutputBytes(maxTotalBytes: number): number {
  return Math.min(Math.max(maxTotalBytes * 2 + 131_072, 524_288), 4_194_304);
}

function decodeUtf8Bounded(
  bytes: Uint8Array,
  limit: number,
  trimTrailingIncomplete: boolean,
): string {
  const capped = bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
  let end = capped.byteLength;
  if (trimTrailingIncomplete && end > 0) {
    let cont = 0;
    while (end > 0 && (capped[end - 1]! & 0xc0) === 0x80 && cont < 3) {
      end -= 1;
      cont += 1;
    }
    if (end > 0) {
      const lead = capped[end - 1]!;
      const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
      if (1 + cont < expected) {
        end -= 1;
      } else {
        end = capped.byteLength;
      }
    }
  }
  return Buffer.from(capped.buffer, capped.byteOffset, end).toString("utf8");
}

function concatUint8Arrays(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function runBoundedSandboxCommand(
  sandbox: RepositorySandbox,
  command: string,
  maxOutputBytes: number,
): Promise<BoundedCommandResult> {
  const stdoutLimit = Math.max(1, Math.floor(maxOutputBytes));
  if (typeof sandbox.spawn !== "function") {
    const result = await sandbox.run({ command });
    const stdoutBuf = Buffer.from(result.stdout, "utf8");
    const stderrBuf = Buffer.from(result.stderr, "utf8");
    const stdoutOverflow = stdoutBuf.byteLength > stdoutLimit;
    const stderrOverflow = stderrBuf.byteLength > MAX_STDERR_BYTES;
    return {
      exitCode: result.exitCode,
      stdout: stdoutOverflow ? decodeUtf8Bounded(stdoutBuf, stdoutLimit, true) : result.stdout,
      stderr: stderrOverflow ? decodeUtf8Bounded(stderrBuf, MAX_STDERR_BYTES, true) : result.stderr,
      overflowed: stdoutOverflow || stderrOverflow,
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

  const collectStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    limit: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined || value.byteLength === 0) continue;
        if (overflowed) break;
        const remaining = limit - total;
        if (value.byteLength > remaining) {
          if (remaining > 0) {
            chunks.push(value.slice(0, remaining));
            total += remaining;
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
    return { bytes: concatUint8Arrays(chunks, total), truncated };
  };

  const [stdoutCollected, stderrCollected] = await Promise.all([
    collectStream(stdoutReader, stdoutLimit),
    collectStream(stderrReader, MAX_STDERR_BYTES),
  ]);

  if (overflowed) {
    if (killPromise !== null) await killPromise;
    void Promise.resolve(proc.wait()).catch(() => undefined);
    return {
      exitCode: 1,
      stdout: decodeUtf8Bounded(stdoutCollected.bytes, stdoutLimit, stdoutCollected.truncated),
      stderr: decodeUtf8Bounded(stderrCollected.bytes, MAX_STDERR_BYTES, stderrCollected.truncated),
      overflowed: true,
    };
  }

  const { exitCode } = await proc.wait();
  return {
    exitCode,
    stdout: decodeUtf8Bounded(stdoutCollected.bytes, stdoutLimit, false),
    stderr: decodeUtf8Bounded(stderrCollected.bytes, MAX_STDERR_BYTES, false),
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
  if (typeof match === "function") {
    try {
      return Boolean(match(repo));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`eve-code repository rule match failed for ${repo.root}: ${detail}`);
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

function shellHelpers(boundary: string, maxFileBytes: number, maxTotalBytes: number): string {
  const b = shellQuote(boundary);
  const fileBytes = Math.max(1, Math.floor(maxFileBytes));
  const headBytes = fileBytes + 1;
  const totalBytes = Math.max(0, Math.floor(maxTotalBytes));
  const cfgDelimiter = `${boundary}_CFG`;
  const ckDelimiter = `${boundary}_CK`;
  const lsDelimiter = `${boundary}_LS`;
  const scanDelimiter = `${boundary}_SCAN`;
  return [
    `B=${b}`,
    `NL='`,
    `'`,
    `MAX_FILE=${fileBytes}`,
    `MAX_HEAD=${headBytes}`,
    `MAX_TOTAL_BYTES=${totalBytes}`,
    `MAX_REPOS=${MAX_DISCOVERED_REPOSITORIES}`,
    `MAX_SCAN_CANDS=${MAX_SCAN_CANDIDATES}`,
    `MAX_SCAN_DIRS=${MAX_SCAN_DIRS}`,
    `MAX_META=${MAX_META_FIELD_BYTES}`,
    `MAX_OVERFLOW=${MAX_OVERFLOW_PATHS}`,
    `REPO_COUNT=0`,
    `SKIPPED_REPOS=0`,
    `TOTAL_BYTES=0`,
    `BUDGET_EXHAUSTED=0`,
    `OVERFLOW_COUNT=0`,
    `_SCAN_EMITTED=0`,
    `_SCAN_VISITED=0`,
    `_REPO_FP=""`,
    `_REPO_FP_OK=1`,
    `_PROBE_FP=""`,
    `_PROBE_BYTES=0`,
    `_repo_git_fallback=1`,
    `_r_out=""`,
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
    `scan_repos_under() {`,
    `  _level=""`,
    `  for _root in "$@"; do`,
    `    [ -d "$_root" ] || continue`,
    `    _root_real=$(canon_path "$_root" 2>/dev/null || true)`,
    `    [ -n "$_root_real" ] || continue`,
    `    case "\${NL}\${_level}" in *"\${NL}\${_root_real}\${NL}"*) continue ;; esac`,
    `    _level="\${_level}\${_root_real}\${NL}"`,
    `  done`,
    `  _depth=0`,
    `  while [ "$_depth" -le 3 ] && [ -n "$_level" ]; do`,
    `    _next_level=""`,
    `    _next_count=0`,
    `    while IFS= read -r _dir; do`,
    `      [ -n "$_dir" ] || continue`,
    `      if [ "$_SCAN_EMITTED" -ge "$MAX_SCAN_CANDS" ] || [ "$_SCAN_VISITED" -ge "$MAX_SCAN_DIRS" ]; then`,
    `        return 0`,
    `      fi`,
    `      _SCAN_VISITED=$((_SCAN_VISITED + 1))`,
    `      if [ -e "$_dir/.git" ]; then`,
    `        _SCAN_EMITTED=$((_SCAN_EMITTED + 1))`,
    `        printf '%s\\n' "$_dir"`,
    `        continue`,
    `      fi`,
    `      [ "$_depth" -lt 3 ] || continue`,
    `      [ "$_next_count" -lt "$MAX_SCAN_DIRS" ] || continue`,
    `      if [ "$_dir" = "/" ]; then _pfx=""; else _pfx="$_dir"; fi`,
    `      for _child in "$_pfx"/* "$_pfx"/.[!.]* "$_pfx"/..?*; do`,
    `        [ ! -L "$_child" ] && [ -d "$_child" ] || continue`,
    `        _base="\${_child##*/}"`,
    `        case "$_base" in`,
    `          .git|node_modules|.next|dist|build|.turbo|target|vendor|.venv|__pycache__) continue ;;`,
    `        esac`,
    `        _next_level="\${_next_level}\${_child}\${NL}"`,
    `        _next_count=$((_next_count + 1))`,
    `        if [ "$_next_count" -ge "$MAX_SCAN_DIRS" ]; then break; fi`,
    `      done`,
    `    done <<${scanDelimiter}`,
    `$_level`,
    `${scanDelimiter}`,
    `    _level="$_next_level"`,
    `    _depth=$((_depth + 1))`,
    `  done`,
    `}`,
    `emit_overflow() {`,
    `  _kind="$1"; _opath="$2"`,
    `  if [ "$OVERFLOW_COUNT" -lt "$MAX_OVERFLOW" ]; then`,
    `    OVERFLOW_COUNT=$((OVERFLOW_COUNT + 1))`,
    `    _opath_out=$(printf '%s' "$_opath" | tr -d '\\r\\n' | head -c "$MAX_META")`,
    `    printf '%s %s %s\\n' "$B" "$_kind" "$_opath_out"`,
    `  fi`,
    `}`,
    `consume_budget() {`,
    `  _bytes="$1"; _opath="$2"`,
    `  [ "$MAX_TOTAL_BYTES" -gt 0 ] 2>/dev/null || return 0`,
    `  if [ "$_bytes" -gt "$MAX_FILE" ] 2>/dev/null; then _bytes="$MAX_FILE"; fi`,
    `  if [ "$BUDGET_EXHAUSTED" -ne 0 ] || [ $((TOTAL_BYTES + _bytes)) -gt "$MAX_TOTAL_BYTES" ]; then`,
    `    BUDGET_EXHAUSTED=1`,
    `    emit_overflow "FILE_OVERFLOW" "$_opath"`,
    `    return 1`,
    `  fi`,
    `  TOTAL_BYTES=$((TOTAL_BYTES + _bytes))`,
    `  return 0`,
    `}`,
    `emit_file_worktree() {`,
    `  _scope="$1"; _base="$2"; _rel="$3"; _full="$4"`,
    `  if [ ! -f "$_full" ] || [ ! -s "$_full" ]; then return 1; fi`,
    `  _real=$(canon_path "$_full" 2>/dev/null || true)`,
    `  [ -n "$_real" ] || return 1`,
    `  path_within "$_real" "$_base" || return 1`,
    `  head -c "$MAX_HEAD" -- "$_real" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `  _ck=$(head -c "$MAX_HEAD" -- "$_real" | cksum 2>/dev/null || true)`,
    `  _crc=""; _emit_bytes=0`,
    `  IFS=' \t' read -r _crc _emit_bytes _ <<${ckDelimiter}`,
    `$_ck`,
    `${ckDelimiter}`,
    `  [ "\${_emit_bytes:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `  if ! consume_budget "$_emit_bytes" "$_real"; then _REPO_FP_OK=0; return 0; fi`,
    `  _REPO_FP="\${_REPO_FP}\${_REPO_FP:+;}w:\${_rel}:\${_crc}:\${_emit_bytes}"`,
    `  printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE worktree\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_real" "$B" "$_rel" "$B" "$B"`,
    `  head -c "$MAX_HEAD" -- "$_real"`,
    `  printf '\\n%s CONTENT_END\\n' "$B"`,
    `  return 0`,
    `}`,
    `probe_file_worktree() {`,
    `  _base="$1"; _rel="$2"; _full="$3"`,
    `  if [ ! -f "$_full" ] || [ ! -s "$_full" ]; then return 1; fi`,
    `  _real=$(canon_path "$_full" 2>/dev/null || true)`,
    `  [ -n "$_real" ] || return 1`,
    `  path_within "$_real" "$_base" || return 1`,
    `  head -c "$MAX_HEAD" -- "$_real" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `  _ck=$(head -c "$MAX_HEAD" -- "$_real" | cksum 2>/dev/null || true)`,
    `  _crc=""; _pbytes=0`,
    `  IFS=' \t' read -r _crc _pbytes _ <<${ckDelimiter}`,
    `$_ck`,
    `${ckDelimiter}`,
    `  [ "\${_pbytes:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `  _capped="$_pbytes"`,
    `  if [ "$_capped" -gt "$MAX_FILE" ] 2>/dev/null; then _capped="$MAX_FILE"; fi`,
    `  _PROBE_BYTES=$((_PROBE_BYTES + _capped))`,
    `  _PROBE_FP="\${_PROBE_FP}\${_PROBE_FP:+;}w:\${_rel}:\${_crc}:\${_pbytes}"`,
    `  return 0`,
    `}`,
    `git_offline() {`,
    `  GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.allow=never "$@"`,
    `}`,
    `emit_file_repo() {`,
    `  _scope="$1"; _repo="$2"; _rel="$3"; _allow_git="\${4:-1}"`,
    `  if [ "$_repo" = "/" ]; then _full="/$_rel"; else _full="$_repo/$_rel"; fi`,
    `  if [ -e "$_full" ] || [ -L "$_full" ]; then`,
    `    emit_file_worktree "$_scope" "$_repo" "$_rel" "$_full"`,
    `    return $?`,
    `  fi`,
    `  if [ "$_allow_git" != "1" ]; then return 1; fi`,
    `  _ls=$(git_offline -c core.quotePath=false --literal-pathspecs -C "$_repo" ls-tree HEAD -- "$_rel" 2>/dev/null | head -n 1 || true)`,
    `  [ -n "$_ls" ] || return 1`,
    `  IFS=' \t' read -r _mode _kind _oid _rest <<${lsDelimiter}`,
    `$_ls`,
    `${lsDelimiter}`,
    `  [ "$_kind" = "blob" ] || return 1`,
    `  [ "$_mode" = "100644" ] || [ "$_mode" = "100755" ] || return 1`,
    `  [ -n "$_oid" ] || return 1`,
    `  if git_offline -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then`,
    `    _sz=$(git_offline -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)`,
    `    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `    _emit_bytes="$_sz"`,
    `    if [ "$_emit_bytes" -gt "$MAX_HEAD" ] 2>/dev/null; then _emit_bytes="$MAX_HEAD"; fi`,
    `    if ! consume_budget "$_emit_bytes" "$_full"; then _REPO_FP_OK=0; return 0; fi`,
    `    _REPO_FP="\${_REPO_FP}\${_REPO_FP:+;}g:\${_rel}:\${_oid}"`,
    `    printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE git\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B"`,
    `    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD"`,
    `    printf '\\n%s CONTENT_END\\n' "$B"`,
    `    return 0`,
    `  fi`,
    `  if run_with_timeout ${PROMISOR_FETCH_TIMEOUT_SECONDS} env GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then`,
    `    _sz=$(git_offline -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)`,
    `    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `    _emit_bytes="$_sz"`,
    `    if [ "$_emit_bytes" -gt "$MAX_HEAD" ] 2>/dev/null; then _emit_bytes="$MAX_HEAD"; fi`,
    `    if ! consume_budget "$_emit_bytes" "$_full"; then _REPO_FP_OK=0; return 0; fi`,
    `    _REPO_FP="\${_REPO_FP}\${_REPO_FP:+;}g:\${_rel}:\${_oid}"`,
    `    printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE git\\n%s CONTENT_BEGIN\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B"`,
    `    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD"`,
    `    printf '\\n%s CONTENT_END\\n' "$B"`,
    `    return 0`,
    `  fi`,
    `  if [ "$MAX_TOTAL_BYTES" -gt 0 ] 2>/dev/null && [ "$BUDGET_EXHAUSTED" -ne 0 ]; then`,
    `    emit_overflow "FILE_OVERFLOW" "$_full"`,
    `    _REPO_FP_OK=0`,
    `    return 0`,
    `  fi`,
    `  _REPO_FP_OK=0`,
    `  printf '%s FILE_START\\n%s SCOPE %s\\n%s PATH %s\\n%s REL %s\\n%s SOURCE unavailable\\n%s CONTENT_BEGIN\\n\\n%s CONTENT_END\\n' "$B" "$B" "$_scope" "$B" "$_full" "$B" "$_rel" "$B" "$B" "$B"`,
    `  return 0`,
    `}`,
    `probe_file_repo() {`,
    `  _repo="$1"; _rel="$2"; _allow_git="\${3:-1}"`,
    `  if [ "$_repo" = "/" ]; then _full="/$_rel"; else _full="$_repo/$_rel"; fi`,
    `  if [ -e "$_full" ] || [ -L "$_full" ]; then`,
    `    probe_file_worktree "$_repo" "$_rel" "$_full"`,
    `    return $?`,
    `  fi`,
    `  if [ "$_allow_git" != "1" ]; then return 1; fi`,
    `  _ls=$(git_offline -c core.quotePath=false --literal-pathspecs -C "$_repo" ls-tree HEAD -- "$_rel" 2>/dev/null | head -n 1 || true)`,
    `  [ -n "$_ls" ] || return 1`,
    `  IFS=' \t' read -r _mode _kind _oid _rest <<${lsDelimiter}`,
    `$_ls`,
    `${lsDelimiter}`,
    `  [ "$_kind" = "blob" ] || return 1`,
    `  [ "$_mode" = "100644" ] || [ "$_mode" = "100755" ] || return 1`,
    `  [ -n "$_oid" ] || return 1`,
    `  if git_offline -C "$_repo" cat-file -e "$_oid" 2>/dev/null; then`,
    `    _sz=$(git_offline -C "$_repo" cat-file -s "$_oid" 2>/dev/null || echo 0)`,
    `    [ "\${_sz:-0}" -gt 0 ] 2>/dev/null || return 1`,
    `    git_offline -C "$_repo" cat-file -p "$_oid" 2>/dev/null | head -c "$MAX_HEAD" | LC_ALL=C grep -q '[^[:space:]]' 2>/dev/null || return 1`,
    `    _capped="$_sz"`,
    `    if [ "$_capped" -gt "$MAX_FILE" ] 2>/dev/null; then _capped="$MAX_FILE"; fi`,
    `    _PROBE_BYTES=$((_PROBE_BYTES + _capped))`,
    `    _PROBE_FP="\${_PROBE_FP}\${_PROBE_FP:+;}g:\${_rel}:\${_oid}"`,
    `    return 0`,
    `  fi`,
    `  _PROBE_FP="\${_PROBE_FP}\${_PROBE_FP:+;}u:\${_rel}:\${_oid}"`,
    `  return 0`,
    `}`,
    `emit_repo_meta() {`,
    `  _r="$1"`,
    `  _head=$(git_offline -C "$_r" rev-parse --verify HEAD 2>/dev/null | tr -d '\\r\\n' | head -c "$MAX_META" || true)`,
    `  _branch=$(git_offline -C "$_r" symbolic-ref --short -q HEAD 2>/dev/null | tr -d '\\r\\n' | head -c "$MAX_META" || true)`,
    `  _remote=""`,
    `  _sparse_cfg=0`,
    `  _promisor=0`,
    `  _cfg_out=$(git_offline -C "$_r" config --get-regexp '^(remote\\.origin\\.url|core\\.sparsecheckout|remote\\..*\\.promisor)$' 2>/dev/null | head -c 65536 || true)`,
    `  if [ -n "$_cfg_out" ]; then`,
    `    while IFS= read -r _cfg_line; do`,
    `      [ -n "$_cfg_line" ] || continue`,
    `      _k="\${_cfg_line%% *}"`,
    `      if [ "$_k" = "$_cfg_line" ]; then _v=""; else _v="\${_cfg_line#* }"; fi`,
    `      case "$_k" in`,
    `        remote.origin.url) _remote="$_v" ;;`,
    `        core.sparsecheckout)`,
    `          case "$_v" in`,
    `            ""|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]|1) _sparse_cfg=1 ;;`,
    `            *) _sparse_cfg=0 ;;`,
    `          esac`,
    `          ;;`,
    `        remote.*.promisor)`,
    `          case "$_v" in`,
    `            [Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]|[Oo][Ff][Ff]|0) ;;`,
    `            *) _promisor=1 ;;`,
    `          esac`,
    `          ;;`,
    `      esac`,
    `    done <<${cfgDelimiter}`,
    `$_cfg_out`,
    `${cfgDelimiter}`,
    `  fi`,
    `  if [ -n "$_remote" ]; then`,
    `    _remote=$(printf '%s' "$_remote" | tr -d '\\r\\n' | head -c "$MAX_META")`,
    `  fi`,
    `  _sparse=0`,
    `  if [ "$_sparse_cfg" = "1" ] || [ "$_promisor" = "1" ]; then _sparse=1; fi`,
    `  _repo_git_fallback="$_sparse"`,
    `  if [ "$_repo_git_fallback" = "0" ]; then`,
    `    _has_wt_entry=0`,
    `    if [ "$_r" = "/" ]; then _rpfx=""; else _rpfx="$_r"; fi`,
    `    for _e in "$_rpfx"/* "$_rpfx"/.[!.]* "$_rpfx"/..?*; do`,
    `      [ -e "$_e" ] || [ -L "$_e" ] || continue`,
    `      [ "\${_e##*/}" = ".git" ] && continue`,
    `      _has_wt_entry=1`,
    `      break`,
    `    done`,
    `    if [ "$_has_wt_entry" = "0" ]; then _repo_git_fallback=1; fi`,
    `  fi`,
    `  _r_out=$(printf '%s' "$_r" | tr -d '\\r\\n' | head -c "$MAX_META")`,
    `  printf '%s REPO_START\\n%s ROOT %s\\n%s REMOTE %s\\n%s HEAD %s\\n%s BRANCH %s\\n%s SPARSE %s\\n%s REPO_END\\n' "$B" "$B" "$_r_out" "$B" "$_remote" "$B" "$_head" "$B" "$_branch" "$B" "$_sparse" "$B"`,
    `}`,
  ].join("\n");
}

function emitSpecsForRepoShell(
  repoVar: string,
  scopeExpr: string,
  specs: readonly (readonly string[])[],
  prefixVar?: string,
  allowGitExpr?: string,
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  const allowArg = allowGitExpr !== undefined ? ` "${allowGitExpr}"` : "";
  for (const candidates of specs) {
    lines.push("for _cand in " + candidates.map(shellQuote).join(" ") + "; do");
    const relExpr = prefixVar !== undefined ? `${prefixVar}$_cand` : "$_cand";
    lines.push(
      `  if emit_file_repo ${scopeExpr} "${repoVar}" "${relExpr}"${allowArg}; then break; fi`,
    );
    lines.push("done");
  }
  return lines.join("\n");
}

function probeSpecsForRepoShell(
  repoVar: string,
  specs: readonly (readonly string[])[],
  allowGitExpr: string,
): string {
  if (specs.length === 0) return "";
  const lines: string[] = [];
  for (const candidates of specs) {
    lines.push("for _cand in " + candidates.map(shellQuote).join(" ") + "; do");
    lines.push(`  if probe_file_repo "${repoVar}" "$_cand" "${allowGitExpr}"; then break; fi`);
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
  readonly finishedJobDirs: readonly string[];
  readonly overflowPaths: readonly string[];
  readonly unchangedFileRoots: ReadonlySet<string>;
  readonly unchangedRuleFileRoots: ReadonlySet<string>;
  readonly fileFingerprints: Readonly<Record<string, string>>;
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
  const finishedJobDirs: string[] = [];
  const seenFinished = new Set<string>();
  const overflowPaths: string[] = [];
  const seenOverflow = new Set<string>();
  const unchangedFileRoots = new Set<string>();
  const unchangedRuleFileRoots = new Set<string>();
  const fileFingerprints: Record<string, string> = {};

  const pushOverflow = (opath: string) => {
    if (opath.length === 0 || seenOverflow.has(opath)) return;
    if (overflowPaths.length >= MAX_OVERFLOW_PATHS) return;
    seenOverflow.add(opath);
    overflowPaths.push(opath);
  };

  const prefix = `${boundary} `;
  let cursor = 0;

  function readLine(): string | null {
    if (cursor >= stdout.length) return null;
    const nl = stdout.indexOf("\n", cursor);
    if (nl === -1) {
      const line = stdout.slice(cursor);
      cursor = stdout.length;
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    const line = stdout.slice(cursor, nl);
    cursor = nl + 1;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
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

    if (rest.startsWith("JOB_DONE ")) {
      const dir = rest.slice("JOB_DONE ".length);
      if (dir.length > 0 && !seenFinished.has(dir)) {
        seenFinished.add(dir);
        finishedJobDirs.push(dir);
      }
      continue;
    }

    if (rest.startsWith("REPO_OVERFLOW ")) {
      pushOverflow(rest.slice("REPO_OVERFLOW ".length));
      continue;
    }

    if (rest.startsWith("FILE_OVERFLOW ")) {
      pushOverflow(rest.slice("FILE_OVERFLOW ".length));
      continue;
    }

    if (rest.startsWith("REPO_FILES_UNCHANGED ")) {
      const root = rest.slice("REPO_FILES_UNCHANGED ".length);
      if (root.length > 0) unchangedFileRoots.add(root);
      continue;
    }

    if (rest.startsWith("REPO_RULE_FILES_UNCHANGED ")) {
      const root = rest.slice("REPO_RULE_FILES_UNCHANGED ".length);
      if (root.length > 0) unchangedRuleFileRoots.add(root);
      continue;
    }

    if (rest.startsWith("REPO_FINGERPRINT ")) {
      const payload = rest.slice("REPO_FINGERPRINT ".length);
      const sep = payload.lastIndexOf("\t");
      if (sep > 0) {
        const root = payload.slice(0, sep);
        const fp = payload.slice(sep + 1);
        if (root.length > 0 && fp.length > 0) fileFingerprints[root] = fp;
      }
      continue;
    }

    if (rest === "REPO_START") {
      let root = "";
      let remoteRaw = "";
      let headRaw = "";
      let branchRaw = "";
      let sparseRaw = "0";
      let ended = false;
      while (cursor < stdout.length) {
        const inner = readLine();
        if (inner === null) break;
        if (!inner.startsWith(prefix)) continue;
        const field = inner.slice(prefix.length);
        if (field === "REPO_END") {
          ended = true;
          break;
        }
        if (field.startsWith("ROOT ")) root = field.slice("ROOT ".length);
        else if (field.startsWith("REMOTE ")) remoteRaw = field.slice("REMOTE ".length);
        else if (field.startsWith("HEAD ")) headRaw = field.slice("HEAD ".length);
        else if (field.startsWith("BRANCH ")) branchRaw = field.slice("BRANCH ".length);
        else if (field.startsWith("SPARSE ")) sparseRaw = field.slice("SPARSE ".length);
      }
      if (ended && root.length > 0 && !seenRepos.has(root)) {
        seenRepos.add(root);
        if (repos.length >= MAX_DISCOVERED_REPOSITORIES) {
          pushOverflow(root);
        } else {
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
      }
      continue;
    }

    if (rest === "FILE_START") {
      let scope = "";
      let path = "";
      let relativePath = "";
      let source: RepositoryInstructionFile["source"] = "worktree";
      let contentRaw = "";
      let contentComplete = false;
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
            contentComplete = true;
            cursor = endIdx + endMarker.length;
            if (stdout[cursor] === "\r") cursor += 1;
            if (stdout[cursor] === "\n") cursor += 1;
          }
          break;
        }
      }
      if (path.length === 0 || relativePath.length === 0) continue;
      if (!contentComplete) {
        pushOverflow(path);
        continue;
      }
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

  return {
    workspaceRoot,
    homeDir,
    enclosingRepoRoot,
    repos,
    files,
    checkedDirs,
    finishedJobDirs,
    overflowPaths,
    unchangedFileRoots,
    unchangedRuleFileRoots,
    fileFingerprints,
  };
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
    readonly maxTotalBytes?: number;
    readonly includeWorkspaceInstructions?: boolean;
    readonly extraPaths?: readonly string[];
    readonly existingRoots?: readonly string[];
    readonly knownFingerprints?: Readonly<Record<string, string>>;
    readonly knownRuleProbes?: Readonly<
      Record<
        string,
        {
          readonly specs: readonly RepositoryInstructionSpec[];
          readonly fingerprint: string;
        }
      >
    >;
    readonly pendingJobs?: readonly {
      readonly outputDirectory: string;
      readonly pid?: number;
    }[];
  } = {},
): Promise<WorkspaceDiscoveryResult> {
  const roots = validateRoots(options.roots);
  const specs = validateInstructionSpecs(options.instructions);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const maxTotalBytes = validateMaxTotalBytes(options.maxTotalBytes);
  const includeWorkspaceInstructions = options.includeWorkspaceInstructions ?? false;
  const extraPaths = options.extraPaths ?? [];
  const existingRoots = options.existingRoots ?? [];
  const knownFingerprints = options.knownFingerprints ?? {};
  const knownFingerprintEntries = Object.entries(knownFingerprints).filter(
    ([root, fp]) => root.length > 0 && fp.length > 0,
  );
  const knownRuleProbeEntries = Object.entries(options.knownRuleProbes ?? {})
    .map(([root, probe]) => ({
      root,
      specs: normalizeSpecs(probe.specs),
      fingerprint: probe.fingerprint,
    }))
    .filter(
      (entry) => entry.root.length > 0 && entry.specs.length > 0 && entry.fingerprint.length > 0,
    );
  const pendingJobs = options.pendingJobs ?? [];

  const boundary = createBoundary();
  const candDelimiter = `${boundary}_CANDS`;
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

  const knownFpLines =
    knownFingerprintEntries.length > 0
      ? [
          `lookup_known_fp() {`,
          `  case "$1" in`,
          ...knownFingerprintEntries.map(
            ([root, fp]) => `    ${shellQuote(root)}) _known_fp=${shellQuote(fp)} ;;`,
          ),
          `    *) _known_fp="" ;;`,
          `  esac`,
          `}`,
        ]
      : [];

  const knownRuleProbeLines =
    knownRuleProbeEntries.length > 0
      ? [
          `probe_known_rule_files() {`,
          `  case "$1" in`,
          ...knownRuleProbeEntries.flatMap((entry) => [
            `    ${shellQuote(entry.root)})`,
            `      _PROBE_FP=""`,
            `      _PROBE_BYTES=0`,
            probeSpecsForRepoShell("$_repo_real", entry.specs, "$_repo_git_fallback"),
            `      if [ "\${_PROBE_FP:-empty}" = ${shellQuote(entry.fingerprint)} ]; then`,
            `        printf '%s REPO_RULE_FILES_UNCHANGED %s\\n' "$B" "$_r_out"`,
            `      fi`,
            `      ;;`,
          ]),
          `  esac`,
          `}`,
        ]
      : [];

  const repoFilesBlock =
    knownFingerprintEntries.length > 0
      ? [
          `    _known_fp=""`,
          `    lookup_known_fp "$_r_out"`,
          `    _skip_emit=0`,
          `    if [ -n "$_known_fp" ]; then`,
          `      _PROBE_FP=""`,
          `      _PROBE_BYTES=0`,
          probeSpecsForRepoShell("$_repo_real", specs, "$_repo_git_fallback"),
          `      _computed_fp="\${_PROBE_FP:-empty}"`,
          `      if [ "$_computed_fp" = "$_known_fp" ]; then`,
          `        if [ "$MAX_TOTAL_BYTES" -le 0 ] 2>/dev/null || { [ "$BUDGET_EXHAUSTED" -eq 0 ] && [ $((TOTAL_BYTES + _PROBE_BYTES)) -le "$MAX_TOTAL_BYTES" ]; }; then`,
          `          TOTAL_BYTES=$((TOTAL_BYTES + _PROBE_BYTES))`,
          `          printf '%s REPO_FILES_UNCHANGED %s\\n' "$B" "$_r_out"`,
          `          _skip_emit=1`,
          `        fi`,
          `      fi`,
          `    fi`,
          `    if [ "$_skip_emit" = "0" ]; then`,
          `      _REPO_FP=""`,
          `      _REPO_FP_OK=1`,
          emitSpecsForRepoShell(
            "$_repo_real",
            '"repo:$_repo_real"',
            specs,
            undefined,
            "$_repo_git_fallback",
          ),
          `      if [ "$_REPO_FP_OK" = "1" ]; then`,
          `        printf '%s REPO_FINGERPRINT %s\\t%s\\n' "$B" "$_r_out" "\${_REPO_FP:-empty}"`,
          `      fi`,
          `    fi`,
        ]
      : [
          `    _REPO_FP=""`,
          `    _REPO_FP_OK=1`,
          emitSpecsForRepoShell(
            "$_repo_real",
            '"repo:$_repo_real"',
            specs,
            undefined,
            "$_repo_git_fallback",
          ),
          `    if [ "$_REPO_FP_OK" = "1" ]; then`,
          `      printf '%s REPO_FINGERPRINT %s\\t%s\\n' "$B" "$_r_out" "\${_REPO_FP:-empty}"`,
          `    fi`,
        ];

  const pendingJobLines = pendingJobs.map((job) => {
    const dirQuoted = shellQuote(job.outputDirectory);
    const pidQuoted = job.pid !== undefined ? shellQuote(String(job.pid)) : "''";
    return [
      `_jdir=${dirQuoted}`,
      `_jpid=${pidQuoted}`,
      `if [ -e "$_jdir/exit" ] || [ ! -d "$_jdir" ] || { [ -n "$_jpid" ] && ! kill -0 -- -"$_jpid" 2>/dev/null; }; then`,
      `  printf '%s JOB_DONE %s\\n' "$B" "$_jdir"`,
      `fi`,
    ].join("\n");
  });

  const script = [
    shellHelpers(boundary, maxFileBytes, maxTotalBytes),
    ...knownFpLines,
    ...knownRuleProbeLines,
    `WS=$(canon_path ${shellQuote(workspacePath)} 2>/dev/null || printf '%s' ${shellQuote(workspacePath)})`,
    `printf '%s WORKSPACE %s\\n' "$B" "$WS"`,
    `if [ -n "\${HOME:-}" ] && [ -d "$HOME" ]; then _hr=$(canon_path "$HOME" 2>/dev/null || printf '%s' "$HOME"); printf '%s HOME %s\\n' "$B" "$_hr"; fi`,
    ...pendingJobLines,
    `SEEN="$NL"`,
    `_cand_list=$(`,
    `  {`,
    ...existingRootLines.map((line) => `    ${line}`),
    ...extraPathLines.map((line) => `    ${line}`),
    ...(resolvedRoots.length > 0 ? [`    scan_repos_under ${quotedRoots}`] : []),
    `  } | head -n ${MAX_SCAN_CANDIDATES}`,
    `)`,
    `if [ -n "$_cand_list" ]; then`,
    `  while IFS= read -r _cand_dir; do`,
    `    [ -n "$_cand_dir" ] || continue`,
    `    [ -d "$_cand_dir" ] || continue`,
    `    _top=$(git_offline -C "$_cand_dir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `    [ -n "$_top" ] || continue`,
    `    _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `    [ -n "$_repo_real" ] || continue`,
    `    case "$SEEN" in *"$NL$_repo_real$NL"*) continue ;; esac`,
    `    SEEN="$SEEN$_repo_real$NL"`,
    `    if [ "$REPO_COUNT" -ge "$MAX_REPOS" ]; then`,
    `      SKIPPED_REPOS=$((SKIPPED_REPOS + 1))`,
    `      emit_overflow "REPO_OVERFLOW" "$_repo_real"`,
    `      continue`,
    `    fi`,
    `    REPO_COUNT=$((REPO_COUNT + 1))`,
    `    emit_repo_meta "$_repo_real"`,
    ...repoFilesBlock,
    ...(knownRuleProbeEntries.length > 0 ? [`    probe_known_rule_files "$_r_out"`] : []),
    `  done <<${candDelimiter}`,
    `$_cand_list`,
    `${candDelimiter}`,
    `fi`,
    ...(includeWorkspaceInstructions && specs.length > 0
      ? [
          `if [ ! -e "$WS/.git" ]; then`,
          emitSpecsForDirWorktreeShell("$WS", "$WS", '"workspace"', specs),
          `fi`,
        ]
      : []),
    `exit 0`,
  ].join("\n");

  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(maxTotalBytes),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
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

  const fileFingerprints: Record<string, string> = { ...parsed.fileFingerprints };
  for (const unchangedRoot of parsed.unchangedFileRoots) {
    const prev = knownFingerprints[unchangedRoot];
    if (prev !== undefined && !(unchangedRoot in fileFingerprints)) {
      fileFingerprints[unchangedRoot] = prev;
    }
  }

  return {
    workspaceRoot,
    homeDir: parsed.homeDir,
    repositories,
    workspaceInstructions,
    finishedJobDirs: parsed.finishedJobDirs,
    overflowPaths: parsed.overflowPaths,
    unchangedFileRoots: parsed.unchangedFileRoots,
    unchangedRuleFileRoots: parsed.unchangedRuleFileRoots,
    fileFingerprints,
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
    shellHelpers(boundary, maxFileBytes, 0),
    `_repo_real=$(canon_path ${shellQuote(resolvedRoot)} 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    `emit_file_repo "single" "$_repo_real" ${shellQuote(relativePath)} || true`,
    `exit 0`,
  ].join("\n");

  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(maxFileBytes),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
    throw new Error(`Could not read repository file: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
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
  readonly fingerprint?: string;
}> {
  const normalized = normalizeSpecs(specs);
  if (normalized.length === 0) return { files: [], overflowPaths: [], fingerprint: "empty" };
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const maxTotalBytes = validateMaxTotalBytes(options.maxTotalBytes);
  const boundary = createBoundary();
  const resolvedRoot = sandbox.resolvePath(repoRoot);

  const allowGitLines =
    options.sparse === true
      ? [`_rule_git_fallback=1`]
      : [
          `_rule_git_fallback=0`,
          `_has_wt_entry=0`,
          `if [ "$_repo_real" = "/" ]; then _rpfx=""; else _rpfx="$_repo_real"; fi`,
          `for _e in "$_rpfx"/* "$_rpfx"/.[!.]* "$_rpfx"/..?*; do`,
          `  [ -e "$_e" ] || [ -L "$_e" ] || continue`,
          `  [ "\${_e##*/}" = ".git" ] && continue`,
          `  _has_wt_entry=1`,
          `  break`,
          `done`,
          `if [ "$_has_wt_entry" = "0" ]; then _rule_git_fallback=1; fi`,
        ];

  const script = [
    shellHelpers(boundary, maxFileBytes, maxTotalBytes),
    `_repo_real=$(canon_path ${shellQuote(resolvedRoot)} 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    `_r_out=$(printf '%s' "$_repo_real" | tr -d '\\r\\n' | head -c "$MAX_META")`,
    ...allowGitLines,
    `_REPO_FP=""`,
    `_REPO_FP_OK=1`,
    emitSpecsForRepoShell(
      "$_repo_real",
      '"repo:$_repo_real"',
      normalized,
      undefined,
      "$_rule_git_fallback",
    ),
    `if [ "$_REPO_FP_OK" = "1" ]; then`,
    `  printf '%s REPO_FINGERPRINT %s\\t%s\\n' "$B" "$_r_out" "\${_REPO_FP:-empty}"`,
    `fi`,
    `exit 0`,
  ].join("\n");

  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(maxTotalBytes),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
    throw new Error(`Could not read repository instruction files: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  const fingerprint = Object.values(parsed.fileFingerprints)[0];
  return {
    files: parsed.files.map((entry) => entry.file),
    overflowPaths: parsed.overflowPaths,
    ...(fingerprint !== undefined && { fingerprint }),
  };
}

export async function findEnclosingRepository(
  sandbox: RepositorySandbox,
  targetPath: string,
  options: Pick<DiscoverRepositoriesOptions, "instructions" | "maxFileBytes"> & {
    readonly maxTotalBytes?: number;
  } = {},
): Promise<DiscoveredRepository | null> {
  const specs = normalizeSpecs(options.instructions ?? DEFAULT_REPOSITORY_INSTRUCTIONS);
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const maxTotalBytes = validateMaxTotalBytes(options.maxTotalBytes);
  const boundary = createBoundary();

  const script = [
    shellHelpers(boundary, maxFileBytes, maxTotalBytes),
    `_target=${shellResolveTargetExpr(sandbox, targetPath)}`,
    `if [ -d "$_target" ]; then _dir="$_target"; else _dir=$(dirname -- "$_target"); fi`,
    `[ -d "$_dir" ] || exit 0`,
    `_top=$(git_offline -C "$_dir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `[ -n "$_top" ] || exit 0`,
    `_repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `[ -n "$_repo_real" ] || exit 0`,
    `emit_repo_meta "$_repo_real"`,
    emitSpecsForRepoShell(
      "$_repo_real",
      '"repo:$_repo_real"',
      specs,
      undefined,
      "$_repo_git_fallback",
    ),
    `exit 0`,
  ].join("\n");

  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(maxTotalBytes),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
    throw new Error(`Could not inspect enclosing repository: ${commandFailureDetail(result)}`);
  }
  const parsed = parseProtocolOutput(result.stdout, boundary, maxFileBytes);
  const repositories = attachInstructions(parsed.repos, parsed.files);
  return repositories[0] ?? null;
}

export function computeAncestorDirs(rootDir: string, targetDir: string): readonly string[] {
  const root = normalizePlatformPath(rootDir);
  const target = normalizePlatformPath(targetDir);
  if (target === root) return [];
  const rootIsDriveOrSlash = root === "/" || /^[A-Za-z]:\/$/u.test(root);
  const prefix = rootIsDriveOrSlash ? root : `${root}/`;
  if (!target.startsWith(prefix)) return [];
  const remainder = target.slice(prefix.length);
  if (remainder.length === 0) return [];
  const parts = remainder.split("/").filter((part) => part.length > 0);
  const dirs: string[] = [];
  let current = root;
  for (const part of parts) {
    const isRoot = current === "/" || /^[A-Za-z]:\/$/u.test(current);
    current = isRoot ? `${current}${part}` : `${current}/${part}`;
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
  const maxFileBytes = validateMaxFileBytes(options.maxFileBytes);
  const maxTotalBytes = validateMaxTotalBytes(options.maxTotalBytes);
  const loadScoped = options.loadScoped ?? true;
  const boundary = createBoundary();
  const dirsDelimiter = `${boundary}_DIRS`;
  const workspacePath = sandbox.resolvePath(".");
  const checkedList = [...options.checkedDirs];
  const knownRoots = [...(options.knownRepoRoots ?? [])];
  const sparseRoots = options.sparseRepoRoots !== undefined ? [...options.sparseRepoRoots] : null;

  const checkedCase =
    checkedList.length === 0
      ? "false"
      : `case "$_d" in ${checkedList.map(shellQuote).join("|")}) true ;; *) false ;; esac`;
  const knownRepoCase =
    knownRoots.length === 0
      ? "false"
      : `case "$_repo_real" in ${knownRoots.map(shellQuote).join("|")}) true ;; *) false ;; esac`;
  const sparseRepoCase =
    sparseRoots === null
      ? "true"
      : sparseRoots.length === 0
        ? "false"
        : `case "$_repo_real" in ${sparseRoots.map(shellQuote).join("|")}) true ;; *) false ;; esac`;

  const script = [
    shellHelpers(boundary, maxFileBytes, maxTotalBytes),
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
    `_top=$(git_offline -C "$_tdir" rev-parse --show-toplevel 2>/dev/null || true)`,
    `_repo_real=""`,
    `if [ -n "$_top" ]; then`,
    `  _repo_real=$(canon_path "$_top" 2>/dev/null || true)`,
    `fi`,
    `if [ -n "$_repo_real" ]; then`,
    `  _rel_prefix=$(git_offline -C "$_tdir" rev-parse --show-prefix 2>/dev/null | tr -d '\\r' || true)`,
    `  _rel_prefix="\${_rel_prefix%/}"`,
    `  if [ -n "$_rel_prefix" ]; then`,
    `    if [ "$_repo_real" = "/" ]; then _tdir="/$_rel_prefix"; else _tdir="$_repo_real/$_rel_prefix"; fi`,
    `  else`,
    `    _tdir="$_repo_real"`,
    `  fi`,
    `  printf '%s ENCLOSING_ROOT %s\\n' "$B" "$_repo_real"`,
    `fi`,
    `_scope_allow_git=1`,
    `if [ -n "$_repo_real" ] && ! ${knownRepoCase}; then`,
    `  emit_repo_meta "$_repo_real"`,
    `  _scope_allow_git="$_repo_git_fallback"`,
    `  _REPO_FP=""`,
    `  _REPO_FP_OK=1`,
    emitSpecsForRepoShell(
      "$_repo_real",
      '"repo:$_repo_real"',
      specs,
      undefined,
      "$_repo_git_fallback",
    ),
    `  if [ "$_REPO_FP_OK" = "1" ]; then`,
    `    printf '%s REPO_FINGERPRINT %s\\t%s\\n' "$B" "$_r_out" "\${_REPO_FP:-empty}"`,
    `  fi`,
    `elif [ -n "$_repo_real" ] && ! ${sparseRepoCase}; then`,
    `  _scope_allow_git=0`,
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
          `  if [ -n "$_dirs" ]; then`,
          `    while IFS= read -r _d; do`,
          `      [ -n "$_d" ] || continue`,
          `      if ${checkedCase}; then continue; fi`,
          `      printf '%s CHECKED_DIR %s\\n' "$B" "$_d"`,
          `      if [ -n "$_repo_real" ]; then`,
          `        if [ "$_repo_real" = "/" ]; then _rel_dir="\${_d#/}/"; else _rel_dir="\${_d#"$_repo_real"/}/"; fi`,
          emitSpecsForRepoShell(
            "$_repo_real",
            '"scope:$_d"',
            specs,
            "$_rel_dir",
            "$_scope_allow_git",
          ),
          `      else`,
          emitSpecsForDirWorktreeShell("$_d", "$WS", '"scope:$_d"', specs),
          `      fi`,
          `    done <<${dirsDelimiter}`,
          `$_dirs`,
          `${dirsDelimiter}`,
          `  fi`,
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

  const result = await runBoundedSandboxCommand(
    sandbox,
    script,
    computeMaxOutputBytes(maxTotalBytes),
  );
  if (result.exitCode !== 0 && !result.overflowed) {
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
  const enclosingRepo = repositories[0] ?? null;
  const enclosingRepoFingerprint =
    enclosingRepo !== null ? parsed.fileFingerprints[enclosingRepo.root] : undefined;

  return {
    workspaceRoot: parsed.workspaceRoot ?? workspacePath,
    homeDir: parsed.homeDir,
    enclosingRepoRoot: parsed.enclosingRepoRoot,
    enclosingRepo,
    ...(enclosingRepoFingerprint !== undefined && { enclosingRepoFingerprint }),
    checkedDirs: parsed.checkedDirs,
    scopes,
    overflowPaths: parsed.overflowPaths,
  };
}
