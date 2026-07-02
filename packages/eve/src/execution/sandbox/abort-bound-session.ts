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
 * Wraps a sandbox session so every I/O call carries `abortSignal` by
 * default. This is how the turn's cancellation signal reaches sandbox
 * work without each call site threading it manually: sessions handed to
 * tool executions (`ctx.getSandbox()`, the framework sandbox tools) are
 * bound to the turn signal, so `sandbox.run({ command })` is already
 * cancellable.
 *
 * A signal provided on an individual call is composed with the bound
 * signal via `AbortSignal.any`, so per-call signals (timeouts, caller
 * scopes) add abort reasons but can never opt sandbox work out of turn
 * cancellation.
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
