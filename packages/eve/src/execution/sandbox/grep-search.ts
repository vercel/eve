import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { resolveInWorkspace, type WorkspaceSandbox } from "#execution/sandbox/workspace-root.js";

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

// Containment is enforced on real paths in executeGrepSearch; the workspace
// root differs by provider (/workspace, /app, ...), so no literal prefix here.
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
  const path = assertNoParentSegments(sandbox.resolvePath(input.path ?? ""), input.path);
  const { path: searchRealPath } = await resolveInWorkspace(
    sandbox,
    path,
    "grep path",
    abortSignal,
  );

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
  const result = await sandbox.run({ signal: abortSignal, command });
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

export function buildSearchCommand(input: GrepCommandInput): string {
  return [
    "set -o pipefail",
    "{",
    "  if command -v rg >/dev/null 2>&1; then",
    `    ${buildRipgrepCommand(input)}`,
    "  else",
    `    ${buildPosixGrepCommand(input)}`,
    "  fi",
    // Drain excess diagnostics so truncating stderr cannot SIGPIPE the search.
    `} 2> >({ head -c ${MAX_GREP_LINE_BYTES}; cat >/dev/null; } >&2) | head -c ${MAX_GREP_COMMAND_BYTES + 1}`,
  ].join("\n");
}

export function buildRipgrepCommand(input: GrepCommandInput): string {
  // stdout is piped, so native ripgrep does not add terminal colors. The
  // virtual just-bash implementation supports these search flags, but not --color.
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

  parts.push("-e", shellQuote(input.pattern), shellQuote(input.path));
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

  parts.push("-e", shellQuote(input.pattern), shellQuote(input.path));
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

// The byte cap can cut a JSON record inside its line text, before rg emits
// line_number. Keep the confirmed match and a bounded preview without inventing
// a position or allocating the rest of a minified line.
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
    // A cap can split a JSON escape (at most six characters, e.g. \u1234).
    for (let trim = 0; trim <= 6 && trim <= raw.length; trim += 1) {
      try {
        const value: string = JSON.parse(`"${raw.slice(0, raw.length - trim)}"`);
        return match[1] === "bytes" ? Buffer.from(value, "base64").toString("utf8") : value;
      } catch {
        /* Drop only the incomplete trailing escape. */
      }
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
