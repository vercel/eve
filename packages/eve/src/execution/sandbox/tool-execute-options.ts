/**
 * Per-call options shared by the sandbox tool executors (`bash`, `grep`,
 * `glob`, `read_file`, `write_file`).
 */
export interface SandboxToolExecuteOptions {
  /**
   * Turn cancellation signal forwarded into the underlying sandbox
   * operation so an aborted turn stops the running command or file I/O.
   */
  readonly abortSignal?: AbortSignal;
}
