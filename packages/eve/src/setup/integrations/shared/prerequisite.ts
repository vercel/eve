import { HumanActionRequiredError } from "../../human-action.js";

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

/**
 * The structured prerequisite behind a setup error, if any. Shared Vercel
 * provisioning steps throw {@link HumanActionRequiredError} (for example
 * `vercel login`); setup callers report it as a command prerequisite so the
 * action survives process and protocol boundaries instead of being flattened
 * into an unactionable message.
 */
export function setupPrerequisiteOf(error: unknown): SetupPrerequisite | undefined {
  if (error instanceof SetupPrerequisiteRequired) return error.prerequisite;
  if (error instanceof HumanActionRequiredError) {
    return {
      kind: "command",
      code: error.action.kind,
      message: error.action.reason,
      command: error.action.command,
    };
  }
  return undefined;
}
