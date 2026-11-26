import { normalizeModelPath } from "#execution/tools/file-state.js";
import { runInternalCommand } from "#execution/sandbox/internal-shell.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";

const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 1000;

export interface GlobInput {
  readonly limit?: number;
  readonly path?: string;
  readonly pattern: string;
}

export interface GlobResult {
  readonly content: string;
  readonly count: number;
  readonly path: string;
  readonly truncated: boolean;
}

export async function executeGlobOnSandbox(
  sandbox: SandboxSession,
  args: GlobInput,
): Promise<GlobResult> {
  const resolvedPath = await resolveAbsoluteFilePath(sandbox, args.path ?? ".");
  const normalizedPath = normalizeModelPath(resolvedPath);
  const effectiveLimit = Math.min(Math.max(1, args.limit ?? DEFAULT_GLOB_LIMIT), MAX_GLOB_LIMIT);

  const command = buildGlobCommand({ normalizedPath, pattern: args.pattern });
  const result = await runInternalCommand(sandbox, { command });

  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    (result.exitCode === 1 && result.stderr.trim().length > 0)
  ) {
    throw buildGlobExecutionError(command, result.exitCode, result.stderr);
  }

  const rawLines = result.stdout.split("\n").filter((line) => line.length > 0);

  const truncatedByCount = rawLines.length > effectiveLimit;
  const boundedLines = truncatedByCount ? rawLines.slice(0, effectiveLimit) : rawLines;

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

interface BuildCommandInput {
  readonly normalizedPath: string;
  readonly pattern: string;
}

function buildGlobCommand(input: BuildCommandInput): string {
  return [
    "if command -v rg >/dev/null 2>&1 && {",
    "  _eve_rg=$(rg --line-number --color=never --hidden --glob '!.git/*' --max-count 1 -- '__eve_ripgrep_probe_never_matches__' /dev/null 2>&1)",
    "  _eve_rc=$?",
    '  [ -z "$_eve_rg" ] && { [ "$_eve_rc" -eq 0 ] || [ "$_eve_rc" -eq 1 ]; }',
    "}; then",
    `  ${buildRipgrepCommand(input)}`,
    "else",
    `  ${buildPosixFindCommand(input)}`,
    "fi",
  ].join("\n");
}

function buildRipgrepCommand(input: BuildCommandInput): string {
  return [
    "rg --files --hidden",
    "--glob '!.git/*'",
    `--glob ${shellQuote(input.pattern)}`,
    shellQuote(input.normalizedPath),
  ].join(" ");
}

function buildPosixFindCommand(input: BuildCommandInput): string {
  const translatedPattern = translateGlobToFindPattern(input.pattern);

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

function translateGlobToFindPattern(pattern: string): string {
  let translated = pattern.replaceAll("**", "*");

  while (translated.startsWith("*/")) {
    translated = translated.slice(2);
  }

  return translated;
}

function buildGlobExecutionError(command: string, exitCode: number, stderr: string): Error {
  const trimmed = stderr.trim();
  const detail = trimmed.length > 0 ? trimmed : "no stderr output";
  return new Error(`glob failed (exit ${exitCode}): ${detail}\nCommand: ${command}`);
}
