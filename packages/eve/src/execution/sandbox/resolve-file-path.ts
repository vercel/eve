import type { SandboxSession } from "#public/definitions/sandbox.js";
import { resolveSandboxModelPath } from "#shared/skill-paths.js";

/** Resolves `$HOME` and requires an absolute model-supplied sandbox path. */
export async function resolveAbsoluteFilePath(
  sandbox: SandboxSession,
  filePath: string,
): Promise<string> {
  const resolvedPath = await resolveSandboxModelPath({ path: filePath, sandbox });

  if (!resolvedPath.startsWith("/")) {
    throw new Error(
      `filePath must be an absolute path. Received: "${filePath}". ` +
        "Use an absolute path such as /workspace/foo.ts or a path beginning with $HOME/.",
    );
  }

  return resolvedPath;
}
