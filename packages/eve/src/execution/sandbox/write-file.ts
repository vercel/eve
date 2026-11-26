import { normalizeModelPath } from "#execution/tools/file-state.js";
import { runInternalCommand } from "#execution/sandbox/internal-shell.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface WriteFileInput {
  readonly content: string;
  readonly filePath: string;
}

export interface WriteFileResult {
  readonly existed: boolean;
  readonly path: string;
}

export async function executeWriteFileOnSandbox(
  sandbox: SandboxSession,
  args: WriteFileInput,
): Promise<WriteFileResult> {
  const { filePath, content } = args;

  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const normalizedPath = normalizeModelPath(resolvedPath);

  const probe = await runInternalCommand(sandbox, {
    command: `test -e ${shellQuote(resolvedPath)}`,
  });
  const existed = probe.exitCode === 0;
  await sandbox.writeTextFile({ content, path: resolvedPath });

  return { existed, path: normalizedPath };
}
