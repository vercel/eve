import type { SandboxSession } from "#public/definitions/sandbox.js";
import { MODEL_HOST_SKILL_ROOT, resolveSandboxModelPath } from "#shared/skill-paths.js";

export async function resolveAbsoluteFilePath(
  sandbox: SandboxSession,
  filePath: string,
): Promise<string> {
  const resolvedPath = await resolveSandboxModelPath({ path: filePath, sandbox });

  if (
    resolvedPath === MODEL_HOST_SKILL_ROOT ||
    resolvedPath.startsWith(`${MODEL_HOST_SKILL_ROOT}/`)
  ) {
    throw new Error(
      `Cannot resolve "${filePath}": the sandbox has no usable ${MODEL_HOST_SKILL_ROOT}. ` +
        "Use an absolute path or a path relative to the workspace root.",
    );
  }

  if (
    resolvedPath === "$HOME" ||
    resolvedPath.startsWith("$HOME/") ||
    resolvedPath === "~" ||
    resolvedPath.startsWith("~/")
  ) {
    throw new Error(
      `Cannot resolve "${filePath}": the sandbox has no usable $HOME. ` +
        "Use an absolute path or a path relative to the workspace root.",
    );
  }

  return sandbox.resolvePath(resolvedPath);
}
