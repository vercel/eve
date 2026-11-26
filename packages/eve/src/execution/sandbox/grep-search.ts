import { runInternalCommand } from "#execution/sandbox/internal-shell.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";

export interface WorkspaceSandbox {
  resolvePath(path: string): string;
  run(input: {
    signal?: AbortSignal;
    command: string;
  }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
}

const DEFAULT_GREP_LIMIT = 50;
export const MAX_GREP_LIMIT = 200;
export const MAX_GREP_COMMAND_BYTES = 256 * 1024;
export const MAX_GREP_LINE_BYTES = 8 * 1024;
export const MAX_GREP_RETURN_BYTES = 64 * 1024;
const MAX_ERROR_DETAIL_CHARS = 2_000;
const WORKSPACE_ERR_EXIT = 64;
const TARGET_ERR_EXIT = 65;
const OUTSIDE_WORKSPACE_EXIT = 66;
const WORKSPACE_ERR_PREFIX = "__eve_grep_ws_err__:";
const TARGET_ERR_PREFIX = "__eve_grep_target_err__:";
const OUTSIDE_WORKSPACE_PREFIX = "__eve_grep_outside__:";

const REGEX_META = /[\\^$.*+?()[\]{}|]/u;

export const GREP_OUTPUT_MODES = ["files_with_matches", "content", "count"] as const;

type GrepOutputMode = (typeof GREP_OUTPUT_MODES)[number];

interface GrepCommandInput {
  readonly contextLines: number;
  readonly glob: string | undefined;
  readonly ignoreCase: boolean;
  readonly limit: number;
  readonly literal: boolean;
  readonly outputMode: GrepOutputMode;
  readonly path: string;
  readonly pattern: string;
}

/**
 * Result of a `grep` search: the formatted matches, how many matched, the output mode and
 * path searched, and whether the output was truncated.
 */
export interface GrepSearchResult {
  readonly content: string;
  readonly matchCount: number;
  readonly outputMode: GrepOutputMode;
  readonly path: string;
  readonly truncated: boolean;
}

/**
 * Input to the `grep` tool: the pattern to search for and options that scope the search and
 * shape its output.
 */
export interface GrepToolInput {
  readonly context?: number;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  readonly literal?: boolean;
  readonly outputMode?: GrepOutputMode;
  readonly path?: string;
  readonly pattern: string;
}

export function shouldUseFixedStrings(pattern: string, literal: boolean | undefined): boolean {
  if (literal === true) return true;
  if (literal === false) return false;
  return !REGEX_META.test(pattern);
}

export function effectiveOutputMode(outputMode: GrepOutputMode | undefined): GrepOutputMode {
  return outputMode ?? "files_with_matches";
}

export function effectiveLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_GREP_LIMIT), MAX_GREP_LIMIT);
}

export function assertNoParentSegments(resolved: string, requested?: string): string {
  if (
    (requested !== undefined && requested.split(/[\\/]/u).includes("..")) ||
    resolved.split("/").includes("..")
  ) {
    throw new Error("grep path must not contain '..'");
  }
  return resolved;
}

export async function executeGrepSearch(
  input: GrepToolInput,
  sandbox: WorkspaceSandbox,
  abortSignal?: AbortSignal,
): Promise<GrepSearchResult> {
  if (
    input.path === "$HOME" ||
    input.path?.startsWith("$HOME/") ||
    input.path?.startsWith("${HOME}/")
  ) {
    throw new Error(
      "grep is limited to the sandbox workspace; $HOME paths are not supported. Choose a workspace path or use read_file/glob for home-scoped files.",
    );
  }
  const workspacePath = sandbox.resolvePath("");
  const path = assertNoParentSegments(sandbox.resolvePath(input.path ?? ""), input.path);

  const outputMode = effectiveOutputMode(input.outputMode);
  const limit = effectiveLimit(input.limit);
  const command = buildWorkspaceScopedSearchCommand({
    commandInput: {
      contextLines: input.context ?? 0,
      glob: input.glob,
      ignoreCase: input.ignoreCase === true,
      limit,
      literal: shouldUseFixedStrings(input.pattern, input.literal),
      outputMode,
      path,
      pattern: input.pattern,
    },
    targetPath: path,
    workspacePath,
  });
  const result = await runInternalCommand(sandbox, { signal: abortSignal, command });
  throwIfWorkspaceResolutionFailed(result);
  const commandOutput = truncateUtf8(result.stdout, MAX_GREP_COMMAND_BYTES);
  const commandTruncated = commandOutput.truncated;
  if (
    (result.exitCode !== 0 &&
      result.exitCode !== 1 &&
      !(result.exitCode === 141 && commandTruncated)) ||
    (result.exitCode === 1 && result.stderr.trim().length > 0)
  ) {
    const detail = result.stderr.trim() || commandOutput.value.trim() || "no command output";
    throw new Error(
      `grep failed (exit ${result.exitCode}): ${truncateUtf8(detail, MAX_GREP_LINE_BYTES).value}`,
    );
  }
  return processGrepOutput({
    commandTruncated,
    contextLines: input.context ?? 0,
    limit,
    outputMode,
    path,
    stdout: commandOutput.value,
  });
}

function throwIfWorkspaceResolutionFailed(result: {
  readonly exitCode: number;
  readonly stderr: string;
}): void {
  if (result.exitCode === WORKSPACE_ERR_EXIT && result.stderr.startsWith(WORKSPACE_ERR_PREFIX)) {
    const detail = result.stderr.slice(WORKSPACE_ERR_PREFIX.length).trim() || "no command output";
    throw new Error(
      `sandbox workspace could not be resolved: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
    );
  }
  if (result.exitCode === TARGET_ERR_EXIT && result.stderr.startsWith(TARGET_ERR_PREFIX)) {
    const detail = result.stderr.slice(TARGET_ERR_PREFIX.length).trim() || "no command output";
    throw new Error(`grep path could not be resolved: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`);
  }
  if (
    result.exitCode === OUTSIDE_WORKSPACE_EXIT &&
    result.stderr.startsWith(OUTSIDE_WORKSPACE_PREFIX)
  ) {
    const [workspace, real] = result.stderr.slice(OUTSIDE_WORKSPACE_PREFIX.length).split("\0");
    throw new Error(`grep path resolves outside the workspace ${workspace}: ${real}`);
  }
}

function buildWorkspaceScopedSearchCommand(input: {
  readonly commandInput: GrepCommandInput;
  readonly targetPath: string;
  readonly workspacePath: string;
}): string {
  const quotedWorkspace = shellQuote(input.workspacePath);
  const lines = [
    `if ! IFS= read -r -d '' _eve_ws < <(realpath -e -z -- ${quotedWorkspace} 2>/dev/null) || [ -z "$_eve_ws" ]; then`,
    `  _eve_err=$(realpath -e -z -- ${quotedWorkspace} 2>&1)`,
    `  printf '${WORKSPACE_ERR_PREFIX}%s\\n' "$_eve_err" >&2`,
    `  exit ${WORKSPACE_ERR_EXIT}`,
    "fi",
  ];
  if (input.targetPath === input.workspacePath) {
    lines.push('_eve_target="$_eve_ws"');
  } else {
    const quotedTarget = shellQuote(input.targetPath);
    lines.push(
      `if ! IFS= read -r -d '' _eve_target < <(realpath -e -z -- ${quotedTarget} 2>/dev/null) || [ -z "$_eve_target" ]; then`,
      `  _eve_err=$(realpath -e -z -- ${quotedTarget} 2>&1)`,
      `  printf '${TARGET_ERR_PREFIX}%s\\n' "$_eve_err" >&2`,
      `  exit ${TARGET_ERR_EXIT}`,
      "fi",
      'if [[ "$_eve_ws" != "/" && "$_eve_target" != "$_eve_ws" && "$_eve_target" != "$_eve_ws/"* ]]; then',
      `  printf '${OUTSIDE_WORKSPACE_PREFIX}%s\\0%s\\0' "$_eve_ws" "$_eve_target" >&2`,
      `  exit ${OUTSIDE_WORKSPACE_EXIT}`,
      "fi",
    );
  }
  lines.push(formatSearchPipeline(input.commandInput, '"$_eve_target"'));
  return lines.join("\n");
}

export function buildSearchCommand(input: GrepCommandInput): string {
  return formatSearchPipeline(input, shellQuote(input.path));
}

function formatSearchPipeline(input: GrepCommandInput, targetExpression: string): string {
  return [
    "set -o pipefail",
    "{",
    "  if command -v rg >/dev/null 2>&1; then",
    `    ${formatRipgrepCommand(input, targetExpression)}`,
    "  else",
    `    ${formatPosixGrepCommand(input, targetExpression)}`,
    "  fi",
    `} 2> >({ head -c ${MAX_GREP_LINE_BYTES}; cat >/dev/null; } >&2) | head -c ${MAX_GREP_COMMAND_BYTES + 1}`,
  ].join("\n");
}

export function buildRipgrepCommand(input: GrepCommandInput): string {
  return formatRipgrepCommand(input, shellQuote(input.path));
}

function formatRipgrepCommand(input: GrepCommandInput, targetExpression: string): string {
  const parts = ["rg", "--hidden", "--glob", shellQuote("!.git/*")];

  if (input.ignoreCase) {
    parts.push("--ignore-case");
  }
  if (input.literal) {
    parts.push("--fixed-strings");
  }
  if (input.glob !== undefined) {
    parts.push("--glob", shellQuote(input.glob));
  }

  switch (input.outputMode) {
    case "files_with_matches":
      parts.push("--files-with-matches", "--max-count", "1");
      break;
    case "count":
      parts.push("--count", "--with-filename");
      break;
    case "content":
      parts.push("--line-number", "--with-filename", "--json");
      if (input.contextLines > 0) {
        parts.push("--context", String(input.contextLines));
      }
      parts.push("--max-count", String(input.limit + 1));
      break;
  }

  parts.push("-e", shellQuote(input.pattern), targetExpression);
  return parts.join(" ");
}

export function buildPosixGrepCommand(input: GrepCommandInput): string {
  return formatPosixGrepCommand(input, shellQuote(input.path));
}

function formatPosixGrepCommand(input: GrepCommandInput, targetExpression: string): string {
  const parts = ["grep", "-r", "--exclude-dir=.git"];

  if (input.ignoreCase) {
    parts.push("-i");
  }
  if (input.literal) {
    parts.push("-F");
  } else {
    parts.push("-E");
  }
  if (input.glob !== undefined) {
    parts.push(`--include=${shellQuote(input.glob)}`);
  }

  switch (input.outputMode) {
    case "files_with_matches":
      parts.push("-l");
      break;
    case "count":
      parts.push("-c", "-H");
      break;
    case "content":
      parts.push("-n", "-H", "-Z");
      if (input.contextLines > 0) {
        parts.push("-C", String(input.contextLines));
      }
      parts.push("-m", String(input.limit + 1));
      break;
  }

  parts.push("-e", shellQuote(input.pattern), targetExpression);
  return parts.join(" ");
}

export function processGrepOutput(input: {
  readonly commandTruncated?: boolean;
  readonly contextLines?: number;
  readonly limit: number;
  readonly outputMode: GrepOutputMode;
  readonly path: string;
  readonly stdout: string;
}): GrepSearchResult {
  const rawLines = input.stdout.split("\n");
  const lines: string[] = [];
  const notice = `\n\n[Output truncated. Narrow path or glob, or lower context.]`;
  const contentBudget = MAX_GREP_RETURN_BYTES - Buffer.byteLength(notice);
  let contentBytes = 0;
  let matchCount = 0;
  let returnedRows = 0;
  let previousLocation: { path: string; number: number } | undefined;
  let truncated = input.commandTruncated === true;

  const appendLine = (line: string): boolean => {
    const addedBytes = Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1);
    if (contentBytes + addedBytes > contentBudget) return false;
    lines.push(line);
    contentBytes += addedBytes;
    return true;
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";
    if (rawLine.length === 0 && index === rawLines.length - 1) continue;

    if (rawLine === "--") {
      if (lines.length > 0 && !appendLine(rawLine)) {
        truncated = true;
        break;
      }
      continue;
    }

    let line = rawLine;
    let isMatch = input.outputMode !== "content";
    if (input.outputMode === "content") {
      const normalized = normalizeContentLine(
        rawLine,
        input.commandTruncated === true && index === rawLines.length - 1,
      );
      if (normalized.skip) continue;
      if ((input.contextLines ?? 0) > 0 && normalized.location !== undefined) {
        if (
          previousLocation &&
          (previousLocation.path !== normalized.location.path ||
            normalized.location.number > previousLocation.number + 1)
        ) {
          if (!appendLine("--")) {
            truncated = true;
            break;
          }
        }
        previousLocation = normalized.location;
      }
      line = normalized.line;
      isMatch = normalized.isMatch;
    }

    let counted = 0;
    if (input.outputMode === "count") {
      counted = parseCountLine(line);
      if (counted === 0) continue;
    }

    if (returnedRows >= input.limit) {
      truncated = true;
      break;
    }

    const boundedLine = truncateUtf8(line, MAX_GREP_LINE_BYTES);
    if (boundedLine.truncated) truncated = true;
    if (!appendLine(boundedLine.value)) {
      truncated = true;
      break;
    }
    returnedRows += 1;
    if (input.outputMode === "count") matchCount += counted;
    else if (isMatch) matchCount += 1;
  }

  if (lines.length === 0) {
    return {
      content: truncated ? notice.trimStart() : "No matches found",
      matchCount: 0,
      outputMode: input.outputMode,
      path: input.path,
      truncated,
    };
  }

  let content = lines.join("\n");
  if (truncated) content += notice;

  return {
    content,
    matchCount,
    outputMode: input.outputMode,
    path: input.path,
    truncated,
  };
}

interface ContentLine {
  isMatch: boolean;
  line: string;
  skip?: boolean;
  location?: { path: string; number: number };
}

function normalizeContentLine(line: string, partial = false): ContentLine {
  if (line.startsWith("{")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      if (partial) return partialContentLine(line);
      throw error;
    }
    if (record !== null && typeof record === "object" && "type" in record && "data" in record) {
      if (record.type !== "match" && record.type !== "context")
        return { isMatch: false, line: "", skip: true };
      const data = record.data as {
        path: { text?: string; bytes?: string };
        lines: { text?: string; bytes?: string };
        line_number: number;
      };
      const separator = record.type === "match" ? ":" : "-";
      const content = (
        data.lines.text ?? Buffer.from(data.lines.bytes ?? "", "base64").toString("utf8")
      ).replace(/\n$/u, "");
      const path = data.path.text ?? Buffer.from(data.path.bytes ?? "", "base64").toString("utf8");
      return {
        isMatch: record.type === "match",
        line: `${path}${separator}${data.line_number}${separator}${content}`,
        location: { path, number: data.line_number },
      };
    }
  }

  const separator = line.lastIndexOf("\0");
  if (separator === -1) return { isMatch: false, line };

  const path = line.slice(0, separator);
  const body = line.slice(separator + 1);
  const match = /^(\d+)([:-])(.*)$/u.exec(body);
  if (match === null) return { isMatch: false, line: `${path}:${body}` };

  const [, lineNumber, kind, content] = match;
  return {
    isMatch: kind === ":",
    line: `${path}${kind}${lineNumber}${kind}${content}`,
  };
}

function partialContentLine(line: string): ContentLine {
  const type = /^\s*\{\s*"type"\s*:\s*"(match|context)"/u.exec(line)?.[1];
  if (type === undefined) return { isMatch: false, line: "", skip: true };
  const field = (name: "path" | "lines"): string | undefined => {
    const match = new RegExp(
      `"${name}"\\s*:\\s*\\{\\s*"(text|bytes)"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`,
      "u",
    ).exec(line);
    if (match === null) return undefined;
    const raw = match[2]!.slice(0, MAX_GREP_LINE_BYTES);
    for (let trim = 0; trim <= 6 && trim <= raw.length; trim += 1) {
      try {
        const value: string = JSON.parse(`"${raw.slice(0, raw.length - trim)}"`);
        return match[1] === "bytes" ? Buffer.from(value, "base64").toString("utf8") : value;
      } catch {}
    }
    return undefined;
  };
  const path = field("path") ?? "[path truncated]";
  const preview = field("lines") ?? "[line preview truncated]";
  const number = /"line_number"\s*:\s*(\d+)/u.exec(line)?.[1];
  return {
    isMatch: type === "match",
    line: `${path}:${number ?? "[position truncated]"}:${preview}`,
  };
}

function parseCountLine(line: string): number {
  const separator = line.lastIndexOf(":");
  if (separator === -1) return 0;
  const counted = Number(line.slice(separator + 1));
  return Number.isFinite(counted) && counted > 0 ? counted : 0;
}

function truncateUtf8(value: string, maxBytes: number): { truncated: boolean; value: string } {
  if (Buffer.byteLength(value) <= maxBytes) return { truncated: false, value };

  let bytes = 0;
  let bounded = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return { truncated: true, value: bounded };
}
