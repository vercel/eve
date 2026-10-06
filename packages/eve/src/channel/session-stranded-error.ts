/** The owner of a stranded session, as far as it recorded itself. */
interface StrandedSessionOwner {
  /** eve version that built the owner, when it recorded one. */
  readonly eveVersion?: string;
}

/**
 * Thrown when sending, responding, clearing, or following the live stream of
 * a session whose owner another eve version built, on a World that only runs
 * this build, so the owner can never execute again. Nothing is delivered and
 * nothing is mutated.
 * Call `reset()` to end the session, then start a new one. Narrow with
 * {@link SessionStrandedError.is}.
 */
export class SessionStrandedError extends Error {
  readonly owner: StrandedSessionOwner;

  constructor(owner: StrandedSessionOwner, message?: string) {
    super(message ?? describeStrandedSession(owner));
    this.name = "SessionStrandedError";
    this.owner = owner;
  }

  /** Narrows stranded-session errors across bundle boundaries, where `instanceof` can miss. */
  static is(error: unknown): error is SessionStrandedError {
    return (
      error instanceof SessionStrandedError ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "name") === "SessionStrandedError" &&
        typeof Reflect.get(error, "owner") === "object")
    );
  }
}

/**
 * One actionable sentence pair that names the cause, the version, and the
 * next step. `nextStep` replaces the default recovery instruction.
 */
export function describeStrandedSession(owner: StrandedSessionOwner, nextStep?: string): string {
  const builtBy =
    owner.eveVersion === undefined
      ? "it was created by an earlier eve release"
      : `it was created by eve ${owner.eveVersion}`;
  return `This session is stranded: ${builtBy} on a deployment that is no longer available, so it cannot process messages. ${nextStep ?? "Reset the session to start fresh."}`;
}
