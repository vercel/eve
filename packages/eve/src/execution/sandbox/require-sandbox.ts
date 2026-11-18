import type { SandboxSession } from "#public/definitions/sandbox.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

export async function resolveAbsoluteFilePath(
  sandbox: SandboxSession,
  filePath: string,
): Promise<string> {
  const resolvedPath = await resolveSandboxModelPath({ path: filePath, sandbox });

  if (resolvedPath === "$HOME" || resolvedPath.startsWith("$HOME/")) {
    throw new Error(
      `Cannot resolve "${filePath}": the sandbox has no usable $HOME. ` +
        "Use an absolute path or a path relative to the workspace root.",
    );
  }

  return sandbox.resolvePath(resolvedPath);
}
