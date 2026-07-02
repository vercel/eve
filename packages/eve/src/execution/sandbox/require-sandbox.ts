import { loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import type { SandboxSession } from "#public/definitions/sandbox.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";

/**
 * Resolves the active sandbox session from the runtime context.
 *
 * Shared preamble for every sandbox-backed tool executor (`bash`,
 * `read_file`, `write_file`, `glob`, `grep`). Centralizes the context
 * lookup, null checks, and error messages so each executor does not
 * duplicate them.
 *
 * Binds the returned session to `abortSignal` when provided.
 */
export async function requireSandboxSession(abortSignal?: AbortSignal): Promise<SandboxSession> {
  const sandboxAccess = loadContext().get(SandboxKey);

  if (sandboxAccess === undefined) {
    throw new Error(
      "This tool requires sandbox access on the runtime context. " +
        "Ensure the step is running inside a managed runtime context with sandbox support.",
    );
  }

  const sandbox = await sandboxAccess.get();

  if (sandbox === null) {
    throw new Error("The sandbox is not available in the current runtime context.");
  }

  return abortSignal === undefined ? sandbox : bindSandboxAbortSignal(sandbox, abortSignal);
}

/**
 * Validates that a model-supplied file path is absolute. Throws a
 * descriptive error when the path does not start with `/`.
 */
export function validateAbsoluteFilePath(filePath: string): void {
  if (!filePath.startsWith("/")) {
    throw new Error(
      `filePath must be an absolute path. Received: "${filePath}". ` +
        "Use an absolute path such as /workspace/foo.ts.",
    );
  }
}
