export class EvalRequirementFailed extends Error {
  constructor() {
    super("A required eval assertion failed.");
    this.name = "EvalRequirementFailed";
  }
}

export class EvalSkipped extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EvalSkipped";
    this.reason = reason;
  }
}
