import { mapWithConcurrency } from "#shared/map-with-concurrency.js";
import type { SandboxSession, SandboxWriteFilesOptions } from "#shared/sandbox-session.js";

const FALLBACK_WRITE_CONCURRENCY = 16;

/**
 * Where `buildSandboxSession` puts a provider's batch write. A symbol keeps it
 * off the public session type while session wrappers, which spread or proxy
 * the session, still carry it. A wrapper that changes calls, such as
 * `bindSandboxAbortSignal`, must wrap it too.
 */
export const SANDBOX_WRITE_FILES = Symbol("eve.sandbox.writeFiles");

type SandboxWriteFiles = (options: SandboxWriteFilesOptions) => Promise<void>;

/** The session's batch write, when its provider has one. */
export function getSandboxWriteFiles(session: SandboxSession): SandboxWriteFiles | undefined {
  return (session as { readonly [SANDBOX_WRITE_FILES]?: SandboxWriteFiles })[SANDBOX_WRITE_FILES];
}

/**
 * Writes `files` in one provider call when the provider supports it, and one
 * `writeBinaryFile` per file otherwise. Paths resolve like `writeBinaryFile`.
 */
export async function writeSandboxFiles(
  session: SandboxSession,
  options: SandboxWriteFilesOptions,
): Promise<void> {
  const writeFiles = getSandboxWriteFiles(session);
  if (writeFiles !== undefined) {
    await writeFiles(options);
    return;
  }
  await mapWithConcurrency(options.files, FALLBACK_WRITE_CONCURRENCY, async (file) => {
    await session.writeBinaryFile({
      abortSignal: options.abortSignal,
      content: file.content,
      path: file.path,
    });
  });
}
