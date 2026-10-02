import { shellQuote } from "./shell.ts";

const DEFAULT_GREP_LIMIT = 50;
export const MAX_GREP_LIMIT = 200;
export const MAX_GREP_COMMAND_BYTES = 256 * 1024;
export const MAX_GREP_LINE_BYTES = 8 * 1024;
export const MAX_GREP_RETURN_BYTES = 64 * 1024;

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

export interface GrepSearchResult {
  readonly content: string;
  readonly matchCount: number;
  readonly outputMode: GrepOutputMode;
  readonly path: string;
  readonly truncated: boolean;
}

interface GrepSandbox {
  resolvePath(path: string): string;
  run(input: {
    abortSignal?: AbortSignal;
    command: string;
  }): PromiseLike<{ exitCode: number; stderr: string; stdout: string }>;
}

interface GrepToolInput {
  readonly context?: number;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  readonly literal?: boolean;
  readonly outputMode?: GrepOutputMode;
  readonly path?: string;
  readonly pattern: string;
}

/** Identifiers are faster as fixed strings. Regex syntax keeps the regex engine. */
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

export function assertWorkspacePath(resolved: string, requested?: string): string {
  if (requested !== undefined && requested.split(/[\\/]/u).includes("..")) {
    throw new Error("grep path must not contain '..'");
  }
  if (resolved !== "/workspace" && !resolved.startsWith("/workspace/")) {
    throw new Error(`grep path must stay under /workspace: ${resolved}`);
  }
  if (resolved.split("/").includes("..")) {
    throw new Error("grep path must not contain '..'");
  }
  return resolved;
}

export async function executeGrepSearch(
  input: GrepToolInput,
  sandbox: GrepSandbox,
  abortSignal?: AbortSignal,
): Promise<GrepSearchResult> {
  const path = assertWorkspacePath(sandbox.resolvePath(input.path ?? "/workspace"), input.path);
  const workspaceRealPath = await sandboxRealPath(
    sandbox,
    sandbox.resolvePath(""),
    "sandbox workspace",
    abortSignal,
  );
  const searchRealPath = await sandboxRealPath(sandbox, path, "grep path", abortSignal);
  assertRealPathWithinWorkspace(searchRealPath, workspaceRealPath);

  const outputMode = effectiveOutputMode(input.outputMode);
  const limit = effectiveLimit(input.limit);
  const command = buildSearchCommand({
    contextLines: input.context ?? 0,
    glob: input.glob,
    ignoreCase: input.ignoreCase === true,
    limit,
    literal: shouldUseFixedStrings(input.pattern, input.literal),
    outputMode,
    path: searchRealPath,
    pattern: input.pattern,
  });
  const result = await sandbox.run({ abortSignal, command });
  const commandOutput = truncateUtf8(result.stdout, MAX_GREP_COMMAND_BYTES);
  const commandTruncated = commandOutput.truncated;
  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    (result.exitCode === 1 && result.stderr.trim().length > 0)
  ) {
    const detail = result.stderr.trim() || commandOutput.value.trim() || "no command output";
    throw new Error(
      `grep failed (exit ${result.exitCode}): ${truncateUtf8(detail, MAX_GREP_LINE_BYTES).value}`,
    );
  }
  return processGrepOutput({
    commandTruncated,
    limit,
    outputMode,
    path,
    stdout: commandOutput.value,
  });
}

async function sandboxRealPath(
  sandbox: GrepSandbox,
  path: string,
  label: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const result = await sandbox.run({
    abortSignal,
    command: `realpath -z -- ${shellQuote(path)}`,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no command output";
    throw new Error(
      `${label} could not be resolved: ${truncateUtf8(detail, MAX_GREP_LINE_BYTES).value}`,
    );
  }
  const realPath = result.stdout.endsWith("\0") ? result.stdout.slice(0, -1) : result.stdout;
  if (realPath.length === 0 || realPath.includes("\0")) {
    throw new Error(`${label} returned an invalid realpath`);
  }
  return realPath;
}

function assertRealPathWithinWorkspace(realPath: string, workspaceRealPath: string): void {
  if (realPath !== workspaceRealPath && !realPath.startsWith(`${workspaceRealPath}/`)) {
    throw new Error(`grep path resolves outside /workspace: ${realPath}`);
  }
}

export function buildSearchCommand(input: GrepCommandInput): string {
  return [
    "set -o pipefail",
    "{",
    "  if command -v rg >/dev/null 2>&1; then",
    `    ${buildRipgrepCommand(input)}`,
    "  else",
    `    ${buildPosixGrepCommand(input)}`,
    "  fi",
    `} 2>&1 | head -c ${MAX_GREP_COMMAND_BYTES + 1}`,
    "search_status=${PIPESTATUS[0]}",
    // A producer stopped by the byte cap has already returned all output we will accept.
    'if [ "$search_status" -eq 141 ]; then exit 0; fi',
    'exit "$search_status"',
  ].join("\n");
}

export function buildRipgrepCommand(input: GrepCommandInput): string {
  const parts = ["rg", "--color=never", "--hidden", "--glob", shellQuote("!.git/*")];

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
      parts.push("--count");
      break;
    case "content":
      parts.push("--line-number", "--with-filename", "--null");
      if (input.contextLines > 0) {
        parts.push("--context", String(input.contextLines));
      }
      parts.push("--max-count", String(input.limit));
      break;
  }

  parts.push("--", shellQuote(input.pattern), shellQuote(input.path));
  return parts.join(" ");
}

export function buildPosixGrepCommand(input: GrepCommandInput): string {
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
      parts.push("-c");
      break;
    case "content":
      parts.push("-n", "-H", "-Z");
      if (input.contextLines > 0) {
        parts.push("-C", String(input.contextLines));
      }
      parts.push("-m", String(input.limit));
      break;
  }

  parts.push("-e", shellQuote(input.pattern), shellQuote(input.path));
  return parts.join(" ");
}

export function processGrepOutput(input: {
  readonly commandTruncated?: boolean;
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
      const normalized = normalizeContentLine(rawLine);
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

function normalizeContentLine(line: string): { isMatch: boolean; line: string } {
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
