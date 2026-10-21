import { mapWithConcurrency } from "#shared/map-with-concurrency.js";
import type { SandboxSession, SandboxWriteFilesOptions } from "#shared/sandbox-session.js";

const FALLBACK_WRITE_CONCURRENCY = 16;

/**
 * Where `buildSandboxSession` puts a provider's batch write. A symbol keeps it
 * off the public session type while session wrappers, which spread or proxy
 * the session, still carry it.
 */
export const SANDBOX_WRITE_FILES = Symbol("eve.sandbox.writeFiles");

type BatchWriteSession = SandboxSession & {
  readonly [SANDBOX_WRITE_FILES]?: (options: SandboxWriteFilesOptions) => Promise<void>;
};

/**
 * Writes `files` in one provider call when the provider supports it, and one
 * `writeBinaryFile` per file otherwise. Paths resolve like `writeBinaryFile`.
 */
export async function writeSandboxFiles(
  session: SandboxSession,
  options: SandboxWriteFilesOptions,
): Promise<void> {
  const writeFiles = (session as BatchWriteSession)[SANDBOX_WRITE_FILES];
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
