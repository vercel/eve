import type { SandboxSession } from "#public/definitions/sandbox.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

/**
 * Resolves a model-supplied file path to an absolute sandbox path: a leading
 * `$HOME` through the sandbox's home, and a relative path from the workspace
 * root, where `bash` commands start.
 */
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
