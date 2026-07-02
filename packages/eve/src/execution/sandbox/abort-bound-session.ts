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

/**
 * Returns a sandbox session that applies `abortSignal` to every operation.
 * Per-call signals are composed with the bound signal.
 */
export function bindSandboxAbortSignal(
  session: SandboxSession,
  abortSignal: AbortSignal,
): SandboxSession {
  const compose = (callSignal: AbortSignal | undefined): AbortSignal =>
    callSignal === undefined ? abortSignal : AbortSignal.any([abortSignal, callSignal]);

  return {
    ...session,
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
  };
}
