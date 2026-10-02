import { extname } from "node:path";

import type { SandboxSession } from "eve/sandbox";

import { toolingPaths } from "./tooling.ts";
import { shellQuote } from "./shell.ts";

export interface PostEditDiagnostic {
  readonly check: "git-diff" | "syntax" | "typescript" | "whitespace";
  readonly code?: number;
  readonly column?: number;
  readonly line?: number;
  readonly message: string;
  readonly path?: string;
}

const DIAGNOSTIC_MAX_BYTES = 8 * 1024;
const DIAGNOSTIC_MAX_LINES = 100;

type DiagnosticsSandbox = Pick<SandboxSession, "readTextFile" | "resolvePath" | "run">;

export async function runPostEditDiagnostics(input: {
  readonly addedPaths?: readonly string[];
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly repoRoot: string;
  readonly sandbox: DiagnosticsSandbox;
}): Promise<PostEditDiagnostic[]> {
  const allPaths = [...new Set([...input.changedPaths, ...input.deletedPaths])];
  const diagnostics: PostEditDiagnostic[] = [];
  if (allPaths.length > 0) {
    try {
      const result = await input.sandbox.run({
        command: `git -C ${shellQuote(input.repoRoot)} diff --check -- ${allPaths.map(shellQuote).join(" ")}`,
      });
      if (result.exitCode !== 0) {
        diagnostics.push({
          check: "git-diff",
          message: boundedDiagnostic(result.stderr || result.stdout || "git diff --check failed"),
        });
      }
    } catch (error) {
      diagnostics.push({
        check: "git-diff",
        message: `Could not run git diff --check: ${errorMessage(error)}`,
      });
    }
  }

  for (const path of input.addedPaths ?? []) {
    try {
      const content = await input.sandbox.readTextFile({ path: `${input.repoRoot}/${path}` });
      if (content === null) continue;
      const issues = whitespaceIssues(content);
      if (issues.length > 0) {
        diagnostics.push({ check: "whitespace", path, message: issues.join("\n") });
      }
    } catch (error) {
      diagnostics.push({
        check: "whitespace",
        path,
        message: `Could not inspect added file: ${errorMessage(error)}`,
      });
    }
  }

  for (let index = 0; index < input.changedPaths.length; index += 8) {
    const syntaxResults = await Promise.all(
      input.changedPaths.slice(index, index + 8).map(async (path) => {
        const command = syntaxCommand(input.repoRoot, path);
        if (command === null) return null;
        try {
          const result = await input.sandbox.run({ command });
          if (result.exitCode === 0) return null;
          const message = result.stderr || result.stdout || "syntax check failed";
          if (message.includes("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")) return null;
          return { check: "syntax" as const, path, message: boundedDiagnostic(message) };
        } catch (error) {
          return {
            check: "syntax" as const,
            path,
            message: `Could not run syntax check: ${errorMessage(error)}`,
          };
        }
      }),
    );
    for (const diagnostic of syntaxResults) {
      if (diagnostic !== null) diagnostics.push(diagnostic);
    }
  }
  diagnostics.push(
    ...(await runTypeScriptDiagnostics({
      paths: input.changedPaths,
      repoRoot: input.repoRoot,
      sandbox: input.sandbox,
    })),
  );
  return diagnostics;
}

/**
 * Type diagnostics through the worker installed by `installCodeTooling`.
 * Silently contributes nothing when the worker is absent, so consumers that
 * skip the tooling still get every other check.
 */
export async function runTypeScriptDiagnostics(input: {
  readonly paths: readonly string[];
  readonly repoRoot: string;
  readonly sandbox: DiagnosticsSandbox;
}): Promise<PostEditDiagnostic[]> {
  const typePaths = input.paths.filter(isTypeScriptPath);
  if (typePaths.length === 0) return [];
  const tooling = toolingPaths(input.sandbox);
  if ((await input.sandbox.readTextFile({ path: tooling.worker })) === null) return [];

  const diagnostics: PostEditDiagnostic[] = [];
  for (let index = 0; index < typePaths.length; index += 4) {
    const typeResults = await Promise.all(
      typePaths.slice(index, index + 4).map(async (path) => {
        const request = Buffer.from(
          JSON.stringify({
            filePath: path,
            repoRoot: input.repoRoot,
            typescriptPath: tooling.typescriptModule,
          }),
          "utf8",
        ).toString("base64");
        try {
          const result = await input.sandbox.run({
            command: `node ${shellQuote(tooling.worker)}`,
            env: { EVE_CODE_DIAGNOSTICS_REQUEST: request },
          });
          if (result.exitCode !== 0) {
            return [
              {
                check: "typescript" as const,
                path,
                message: boundedDiagnostic(
                  result.stderr || result.stdout || "TypeScript diagnostics failed",
                ),
              },
            ];
          }
          const parsed = JSON.parse(result.stdout) as {
            diagnostics?: { code: number; column: number; line: number; message: string }[];
          };
          return (parsed.diagnostics ?? []).map((diagnostic) => ({
            check: "typescript" as const,
            code: diagnostic.code,
            column: diagnostic.column,
            line: diagnostic.line,
            message: diagnostic.message,
            path,
          }));
        } catch (error) {
          return [
            {
              check: "typescript" as const,
              path,
              message: `Could not run TypeScript diagnostics: ${errorMessage(error)}`,
            },
          ];
        }
      }),
    );
    diagnostics.push(...typeResults.flat());
  }
  return diagnostics;
}

/** Drop type diagnostics that already existed before the patch, matched by path, code, and message. */
export function onlyNewTypeDiagnostics(
  diagnostics: readonly PostEditDiagnostic[],
  baseline: readonly PostEditDiagnostic[],
): PostEditDiagnostic[] {
  const remaining = new Map<string, number>();
  for (const diagnostic of baseline) {
    if (diagnostic.check !== "typescript" || diagnostic.code === undefined) continue;
    const key = typeDiagnosticKey(diagnostic);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.check !== "typescript" || diagnostic.code === undefined) return true;
    const key = typeDiagnosticKey(diagnostic);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function typeDiagnosticKey(diagnostic: PostEditDiagnostic): string {
  return `${diagnostic.path ?? ""}\0${diagnostic.code ?? ""}\0${diagnostic.message}`;
}

function isTypeScriptPath(path: string): boolean {
  return /\.(?:cts|mts|ts|tsx)$/u.test(path);
}

function syntaxCommand(repoRoot: string, path: string): string | null {
  const quoted = shellQuote(`${repoRoot}/${path}`);
  switch (extname(path).toLowerCase()) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return `node --check ${quoted}`;
    case ".cts":
    case ".mts":
    case ".ts":
      return `node --experimental-strip-types --check ${quoted}`;
    case ".json":
      return `node -e ${shellQuote("JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))")} ${quoted}`;
    case ".bash":
    case ".sh":
      return `bash -n ${quoted}`;
    case ".py":
      return `if command -v python3 >/dev/null 2>&1; then python3 -c ${shellQuote("import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())")} ${quoted}; fi`;
    default:
      return null;
  }
}

/** Keep the tail of long output; errors and final results usually appear last. */
function boundedDiagnostic(value: string): string {
  const lines = value.trim().split("\n");
  let kept = lines.slice(-DIAGNOSTIC_MAX_LINES);
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf8") > DIAGNOSTIC_MAX_BYTES) {
    kept = kept.slice(1);
  }
  const omitted = lines.length - kept.length;
  return omitted > 0 ? `[${omitted} earlier lines omitted]\n${kept.join("\n")}` : kept.join("\n");
}

function whitespaceIssues(content: string): string[] {
  const issues: string[] = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/u.test(line)) {
      issues.push(`line ${index + 1}: unresolved conflict marker`);
    } else if (/[\t ]+$/u.test(line)) {
      issues.push(`line ${index + 1}: trailing whitespace`);
    }
    if (issues.length === 20) break;
  }
  return issues;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
