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
  SandboxWriteFilesOptions,
  SandboxWriteTextFileOptions,
} from "#shared/sandbox-session.js";

/**
 * Returns a sandbox session that applies `abortSignal` to every operation.
 * Per-call signals are composed with the bound signal.
 */
export function bindSandboxAbortSignal<TSession extends SandboxSession>(
  session: TSession,
  abortSignal: AbortSignal,
): TSession {
  const compose = (callSignal: AbortSignal | undefined): AbortSignal =>
    AbortSignal.any(callSignal === undefined ? [abortSignal] : [abortSignal, callSignal]);

  const bound = {
    ...session,
    run: (options: SandboxRunOptions) =>
      session.run({ ...options, signal: compose(options.signal) }),
    spawn: (options: SandboxSpawnOptions) =>
      session.spawn({ ...options, signal: compose(options.signal) }),
    readFile: (options: SandboxReadFileOptions) =>
      session.readFile({ ...options, signal: compose(options.signal) }),
    readBinaryFile: (options: SandboxReadBinaryFileOptions) =>
      session.readBinaryFile({ ...options, signal: compose(options.signal) }),
    readTextFile: (options: SandboxReadTextFileOptions) =>
      session.readTextFile({ ...options, signal: compose(options.signal) }),
    writeFile: (options: SandboxWriteFileOptions) =>
      session.writeFile({ ...options, signal: compose(options.signal) }),
    writeBinaryFile: (options: SandboxWriteBinaryFileOptions) =>
      session.writeBinaryFile({ ...options, signal: compose(options.signal) }),
    writeTextFile: (options: SandboxWriteTextFileOptions) =>
      session.writeTextFile({ ...options, signal: compose(options.signal) }),
    writeFiles: (options: SandboxWriteFilesOptions) =>
      session.writeFiles({ ...options, signal: compose(options.signal) }),
    removePath: (options: SandboxRemovePathOptions) =>
      session.removePath({ ...options, signal: compose(options.signal) }),
  } satisfies SandboxSession;

  // The spread retains provider-specific lifecycle methods not declared on SandboxSession.
  return bound as TSession;
}
