/**
 * Thrown by a provider's `resume()` when the session's native sandbox no
 * longer exists. eve then clears the session's sandbox state and reruns the
 * sandbox selector, which starts a fresh sandbox, as it would after
 * `sandbox.delete()`. Throw it only for a sandbox that is gone; other
 * failures must surface unchanged.
 */
export class SandboxSessionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSessionGoneError";
  }

  /** Also matches an error from another copy of this class, such as one a provider bundles. */
  static is(error: unknown): error is SandboxSessionGoneError {
    return (
      error instanceof SandboxSessionGoneError ||
      (error instanceof Error && error.name === "SandboxSessionGoneError")
    );
  }
}
