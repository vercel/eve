import { normalizeModelPath } from "#runtime/framework-tools/file-state.js";
import { validateAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { ripgrepIsAvailable } from "#execution/sandbox/ripgrep-probe.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { capLineLength, MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 100;
const MAX_GREP_LIMIT = 1000;
const DEFAULT_PATH = "/workspace";

// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeGrepOnSandbox}.
 */
export interface GrepInput {
  readonly context?: number;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  readonly literal?: boolean;
  readonly path?: string;
  readonly pattern: string;
}

/**
 * Structured result returned from {@link executeGrepOnSandbox}.
 */
export interface GrepResult {
  readonly content: string;
  readonly matchCount: number;
  readonly path: string;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Searches file contents for a pattern inside the sandbox.
 */
export async function executeGrepOnSandbox(
  sandbox: SandboxSession,
  args: GrepInput,
): Promise<GrepResult> {
  const effectivePath = args.path ?? DEFAULT_PATH;

  validateAbsoluteFilePath(effectivePath);

  const normalizedPath = normalizeModelPath(effectivePath);
  const effectiveLimit = Math.min(Math.max(1, args.limit ?? DEFAULT_GREP_LIMIT), MAX_GREP_LIMIT);
  const contextLines = args.context !== undefined && args.context > 0 ? args.context : 0;

  const command = (await ripgrepIsAvailable(sandbox))
    ? buildRipgrepCommand({
        contextLines,
        effectiveLimit,
        glob: args.glob,
        ignoreCase: args.ignoreCase ?? false,
        literal: args.literal ?? false,
        normalizedPath,
        pattern: args.pattern,
      })
    : buildPosixGrepCommand({
        contextLines,
        effectiveLimit,
        glob: args.glob,
        ignoreCase: args.ignoreCase ?? false,
        literal: args.literal ?? false,
        normalizedPath,
        pattern: args.pattern,
      });

  const result = await sandbox.run({ command });

  // Both ripgrep and POSIX grep use the same conventional exit codes:
  //   0 — one or more matches were found
  //   1 — no matches found (legitimate empty result)
  //   2 — error occurred (e.g. regex compile failure, IO error)
  // Any other exit code (e.g. 127 from bash when the tool is missing)
  // indicates a real failure. Surface these as structured errors
  // rather than silently pretending the search returned zero matches.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw buildGrepExecutionError(command, result.exitCode, result.stderr);
  }

  const stdout = result.stdout;

  if (stdout.trim().length === 0) {
    return {
      content: "No matches found",
      matchCount: 0,
      path: normalizedPath,
      truncated: false,
    };
  }

  return processOutput({ effectiveLimit, normalizedPath, stdout });
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

interface BuildCommandInput {
  readonly contextLines: number;
  readonly effectiveLimit: number;
  readonly glob: string | undefined;
  readonly ignoreCase: boolean;
  readonly literal: boolean;
  readonly normalizedPath: string;
  readonly pattern: string;
}

/**
 * Builds the ripgrep form of the grep command. Preferred whenever
 * `rg` is on PATH — ripgrep respects `.gitignore` out of the box,
 * handles hidden-file semantics cleanly, and is substantially faster
 * than GNU grep on large repositories.
 *
 * `--no-messages` is intentionally *not* passed — we want ripgrep's
 * error messages to flow through stderr so callers can distinguish a
 * real failure (missing binary, unreadable path) from a legitimate
 * empty result.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  const parts: string[] = ["rg", "--line-number", "--color=never", "--hidden", "--glob '!.git/*'"];

  if (input.ignoreCase) {
    parts.push("--ignore-case");
  }

  if (input.literal) {
    parts.push("--fixed-strings");
  }

  if (input.glob !== undefined) {
    parts.push(`--glob ${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`--context ${input.contextLines}`);
  }

  // `--max-count` limits matches per file; we use it to bound total output.
  parts.push(`--max-count ${input.effectiveLimit}`);
  parts.push("--");
  parts.push(shellQuote(input.pattern));
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

/**
 * Builds the POSIX fallback form of the grep command using `grep -rn`.
 */
function buildPosixGrepCommand(input: BuildCommandInput): string {
  const parts: string[] = ["grep", "-r", "-n", "--color=never", "--exclude-dir=.git"];

  if (input.ignoreCase) {
    parts.push("-i");
  }

  if (input.literal) {
    parts.push("-F");
  } else {
    // Default to ERE so the pattern semantics line up with ripgrep's
    // default (which uses a Rust regex dialect close to ERE).
    parts.push("-E");
  }

  if (input.glob !== undefined) {
    parts.push(`--include=${shellQuote(input.glob)}`);
  }

  if (input.contextLines > 0) {
    parts.push(`-C ${input.contextLines}`);
  }

  // `-m` limits matches per file, analogous to ripgrep's `--max-count`.
  parts.push(`-m ${input.effectiveLimit}`);
  parts.push("--");
  parts.push(shellQuote(input.pattern));
  parts.push(shellQuote(input.normalizedPath));

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

interface ProcessOutputInput {
  readonly effectiveLimit: number;
  readonly normalizedPath: string;
  readonly stdout: string;
}

function processOutput(input: ProcessOutputInput): GrepResult {
  // Process output: truncate long lines, cap total bytes.
  const rawLines = input.stdout.split("\n");
  const outputLines: string[] = [];
  let outputBytes = 0;
  let matchCount = 0;
  let truncatedByBytes = false;

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? "";

    // Skip empty trailing line from split.
    if (rawLine.length === 0 && index === rawLines.length - 1) {
      continue;
    }

    // Count match lines (not context separators like `--`).
    if (rawLine !== "--" && rawLine.length > 0) {
      // Match lines from both rg and POSIX grep have format `file:linenum:text`.
      // Context lines use `file-linenum-text` (rg) or `file-linenum-text` (grep).
      const isMatchLine = /^.+:\d+:/.test(rawLine);
      if (isMatchLine) {
        matchCount++;
      }
    }

    const line = capLineLength(rawLine);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for \n

    if (outputBytes + lineBytes > MAX_OUTPUT_BYTES && outputLines.length > 0) {
      truncatedByBytes = true;
      break;
    }

    outputLines.push(line);
    outputBytes += lineBytes;
  }

  const truncated = truncatedByBytes || matchCount >= input.effectiveLimit;

  let content = outputLines.join("\n");

  if (truncated) {
    const notices: string[] = [];
    if (matchCount >= input.effectiveLimit) {
      notices.push(
        `Match limit reached (${input.effectiveLimit}). Use a larger limit or more specific pattern.`,
      );
    }
    if (truncatedByBytes) {
      notices.push("Output truncated due to size. Use a more specific path or pattern.");
    }
    content += `\n\n[${notices.join(" ")}]`;
  }

  return {
    content,
    matchCount,
    path: input.normalizedPath,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function buildGrepExecutionError(command: string, exitCode: number, stderr: string): Error {
  const trimmed = stderr.trim();
  const detail = trimmed.length > 0 ? trimmed : "no stderr output";
  return new Error(`grep failed (exit ${exitCode}): ${detail}\nCommand: ${command}`);
}
