export type SetupPrerequisite =
  | { kind: "command"; code: string; message: string; command: string }
  | { kind: "environment"; code: string; message: string; variable: string; sensitive: true };

/** A setup blocker whose prerequisite must be satisfied by the caller. */
export class SetupPrerequisiteRequired extends Error {
  readonly prerequisite: SetupPrerequisite;

  constructor(prerequisite: SetupPrerequisite) {
    super(prerequisite.message);
    this.name = "SetupPrerequisiteRequired";
    this.prerequisite = prerequisite;
  }
}
