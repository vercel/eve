import type {
  SandboxReadBinaryFileOptions,
  SandboxReadFileOptions,
  SandboxReadTextFileOptions,
  SandboxRemovePathOptions,
  SandboxRunOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteBinaryFileOptions,
  SandboxWriteFileOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";
import { overrideSandboxSession } from "#execution/sandbox/override-session.js";

/**
 * Returns a sandbox session that applies `abortSignal` to every
 * {@link SandboxSession} I/O operation, composed with any per-call signal.
 *
 * Provider-specific session methods are forwarded without the signal: eve
 * does not know their signatures, so it cannot inject one safely.
 */
export function bindSandboxAbortSignal<TSession extends SandboxSession>(
  session: TSession,
  abortSignal: AbortSignal,
): TSession {
  const compose = (callSignal: AbortSignal | undefined): AbortSignal =>
    AbortSignal.any(callSignal === undefined ? [abortSignal] : [abortSignal, callSignal]);

  return overrideSandboxSession(session, {
    run: (options: SandboxRunOptions) =>
      session.run({ ...options, abortSignal: compose(options.abortSignal) }),
    spawn: (options: SandboxSpawnOptions) =>
      session.spawn({ ...options, abortSignal: compose(options.abortSignal) }),
    readFile: (options: SandboxReadFileOptions) =>
      session.readFile({ ...options, abortSignal: compose(options.abortSignal) }),
    readBinaryFile: (options: SandboxReadBinaryFileOptions) =>
      session.readBinaryFile({ ...options, abortSignal: compose(options.abortSignal) }),
    readTextFile: (options: SandboxReadTextFileOptions) =>
      session.readTextFile({ ...options, abortSignal: compose(options.abortSignal) }),
    writeFile: (options: SandboxWriteFileOptions) =>
      session.writeFile({ ...options, abortSignal: compose(options.abortSignal) }),
    writeBinaryFile: (options: SandboxWriteBinaryFileOptions) =>
      session.writeBinaryFile({ ...options, abortSignal: compose(options.abortSignal) }),
    writeTextFile: (options: SandboxWriteTextFileOptions) =>
      session.writeTextFile({ ...options, abortSignal: compose(options.abortSignal) }),
    removePath: (options: SandboxRemovePathOptions) =>
      session.removePath({ ...options, abortSignal: compose(options.abortSignal) }),
  } satisfies Omit<SandboxSession, "resolvePath">);
}
