/**
 * Thrown by a provider's `resume()` when the session's native sandbox no
 * longer exists. Core then clears the session's sandbox state and starts a
 * fresh sandbox, as it would after `sandbox.delete()`.
 */
export class SandboxSessionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxSessionGoneError";
  }
}
