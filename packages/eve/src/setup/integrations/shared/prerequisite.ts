import { HumanActionRequiredError } from "../../human-action.js";

export type SetupPrerequisite =
  | { kind: "command"; code: string; message: string; command: string }
  | { kind: "environment"; code: string; message: string; variable: string; sensitive: true };

export class SetupPrerequisiteRequired extends Error {
  readonly prerequisite: SetupPrerequisite;

  constructor(prerequisite: SetupPrerequisite) {
    super(prerequisite.message);
    this.name = "SetupPrerequisiteRequired";
    this.prerequisite = prerequisite;
  }
}

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
