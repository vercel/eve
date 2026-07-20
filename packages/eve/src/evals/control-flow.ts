/** Internal signal used to stop an eval after a recorded required assertion fails. */
export class EvalRequirementFailed extends Error {
  constructor() {
    super("A required eval assertion failed.");
    this.name = "EvalRequirementFailed";
  }
}

/** Internal signal used by `t.skip()` to produce a skipped verdict. */
export class EvalSkipped extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EvalSkipped";
    this.reason = reason;
  }
}
