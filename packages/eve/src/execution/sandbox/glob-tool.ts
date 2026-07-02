import { normalizeModelPath } from "#runtime/framework-tools/file-state.js";
import { validateAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { ripgrepIsAvailable } from "#execution/sandbox/ripgrep-probe.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 1000;
const DEFAULT_PATH = "/workspace";

// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeGlobOnSandbox}.
 */
export interface GlobInput {
  readonly limit?: number;
  readonly path?: string;
  readonly pattern: string;
}

/**
 * Structured result returned from {@link executeGlobOnSandbox}.
 */
export interface GlobResult {
  readonly content: string;
  readonly count: number;
  readonly path: string;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Searches for files matching a glob pattern inside the sandbox.
 */
export async function executeGlobOnSandbox(
  sandbox: SandboxSession,
  args: GlobInput,
): Promise<GlobResult> {
  const effectivePath = args.path ?? DEFAULT_PATH;

  validateAbsoluteFilePath(effectivePath);

  const normalizedPath = normalizeModelPath(effectivePath);
  const effectiveLimit = Math.min(Math.max(1, args.limit ?? DEFAULT_GLOB_LIMIT), MAX_GLOB_LIMIT);

  const command = (await ripgrepIsAvailable(sandbox))
    ? buildRipgrepCommand({ normalizedPath, pattern: args.pattern })
    : buildPosixFindCommand({ normalizedPath, pattern: args.pattern });

  const result = await sandbox.run({ command });

  // Both ripgrep and POSIX find use conventional exit code semantics:
  //   0 — operation succeeded (results may be empty for find)
  //   1 — ripgrep-specific: no matches found (legitimate empty result)
  //  >1 — error occurred
  // Any unexpected exit code (e.g. 127 from bash when the tool is
  // missing) indicates a real failure. Surface these as structured
  // errors rather than silently pretending the search returned zero
  // files.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw buildGlobExecutionError(command, result.exitCode, result.stderr);
  }

  // Parse stdout into file paths.
  const rawLines = result.stdout.split("\n").filter((line) => line.length > 0);

  // Detect truncation: if we got more lines than the limit, the tool had more results.
  const truncatedByCount = rawLines.length > effectiveLimit;
  const boundedLines = truncatedByCount ? rawLines.slice(0, effectiveLimit) : rawLines;

  // Normalize each path and enforce byte cap.
  const paths: string[] = [];
  let outputBytes = 0;
  let truncatedByBytes = false;

  for (const line of boundedLines) {
    const normalized = normalizeModelPath(line);
    const lineBytes = Buffer.byteLength(normalized, "utf8") + 1;

    if (outputBytes + lineBytes > MAX_OUTPUT_BYTES && paths.length > 0) {
      truncatedByBytes = true;
      break;
    }

    paths.push(normalized);
    outputBytes += lineBytes;
  }

  if (paths.length === 0) {
    return {
      content: "No files found",
      count: 0,
      path: normalizedPath,
      truncated: false,
    };
  }

  const truncated = truncatedByCount || truncatedByBytes;
  const lines: string[] = [...paths];

  if (truncated) {
    lines.push("");
    lines.push(
      `(Results truncated: showing first ${paths.length} results out of more. ` +
        "Use a more specific path or pattern to narrow results.)",
    );
  }

  return {
    content: lines.join("\n"),
    count: paths.length,
    path: normalizedPath,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

interface BuildCommandInput {
  readonly normalizedPath: string;
  readonly pattern: string;
}

/**
 * Builds the ripgrep form of the glob command. Preferred whenever
 * `rg` is on PATH.
 *
 * Truncation is enforced in JavaScript rather than via a shell `| head`
 * pipe: piping would mask ripgrep's exit code (the pipeline would adopt
 * `head`'s exit code, which is typically 0), making a missing `rg`
 * binary or a real IO failure indistinguishable from a successful
 * search with no results.
 */
function buildRipgrepCommand(input: BuildCommandInput): string {
  return [
    "rg --files --hidden",
    "--glob '!.git/*'",
    `--glob ${shellQuote(input.pattern)}`,
    `-- ${shellQuote(input.normalizedPath)}`,
  ].join(" ");
}

// POSIX fallback used when ripgrep is unavailable. Globstars collapse
// to GNU find's slash-spanning `*`; brace expansion is not supported.
function buildPosixFindCommand(input: BuildCommandInput): string {
  const translatedPattern = translateGlobToFindPattern(input.pattern);

  // If the translated pattern has no slash after translation, it is
  // a basename-only pattern — match against `-name` which is faster
  // and semantically cleaner than `-path`. Otherwise match against
  // the full path with `-path` (note: `-path` requires the full path
  // prefix to match, so we include `*/` to anchor anywhere in the
  // tree).
  const isBasenameOnly = !translatedPattern.includes("/");
  const matchExpression = isBasenameOnly
    ? `-name ${shellQuote(translatedPattern)}`
    : `-path ${shellQuote(`*/${translatedPattern}`)}`;

  return [
    `find ${shellQuote(input.normalizedPath)}`,
    "-type f",
    "-not -path '*/.git/*'",
    matchExpression,
  ].join(" ");
}

// Translates a ripgrep-style glob pattern to a POSIX `find`-compatible
// pattern.
//
//   - A globstar (two `*` in a row) matches any number of directory
//     segments. POSIX `find`'s single `*` also crosses `/` boundaries
//     (unlike bash globs), so a globstar collapses to one `*`.
//   - A leading globstar-slash prefix is equivalent to "at any
//     depth". When the rest of the pattern has no directory
//     component we return just the basename, letting the caller use
//     `-name` for efficiency.
function translateGlobToFindPattern(pattern: string): string {
  // Collapse `**` to `*` since find's `*` already crosses `/`.
  let translated = pattern.replaceAll("**", "*");

  // Strip a leading `*/` so a globstar-prefixed pattern like
  // `**/*.ts` becomes `*.ts` (basename match).
  while (translated.startsWith("*/")) {
    translated = translated.slice(2);
  }

  return translated;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function buildGlobExecutionError(command: string, exitCode: number, stderr: string): Error {
  const trimmed = stderr.trim();
  const detail = trimmed.length > 0 ? trimmed : "no stderr output";
  return new Error(`glob failed (exit ${exitCode}): ${detail}\nCommand: ${command}`);
}
