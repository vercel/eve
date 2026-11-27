import type { SandboxSession } from "#public/definitions/sandbox.js";
import { MODEL_HOST_SKILL_ROOT, resolveSandboxModelPath } from "#shared/skill-paths.js";

export async function resolveAbsoluteFilePath(
  sandbox: SandboxSession,
  filePath: string,
): Promise<string> {
  const resolvedPath = await resolveSandboxModelPath({ path: filePath, sandbox });
  const unexpandedRoot = unexpandedRootOf(resolvedPath);
  if (unexpandedRoot !== undefined) {
    throw new Error(
      `Cannot resolve "${filePath}": the sandbox has no usable ${unexpandedRoot}. ` +
        "Use an absolute path or a path relative to the workspace root.",
    );
  }
  return sandbox.resolvePath(resolvedPath);
}

function unexpandedRootOf(path: string): string | undefined {
  if (path === MODEL_HOST_SKILL_ROOT || path.startsWith(`${MODEL_HOST_SKILL_ROOT}/`)) {
    return MODEL_HOST_SKILL_ROOT;
  }
  if (path === "$HOME" || path.startsWith("$HOME/") || path === "~" || path.startsWith("~/")) {
    return "$HOME";
  }
  return undefined;
}
