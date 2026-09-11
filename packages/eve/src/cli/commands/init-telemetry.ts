import type { EveCliSetupFailureCode } from "#cli/telemetry/index.js";

export type InitTargetFailureCode = Extract<
  EveCliSetupFailureCode,
  "target_conflict" | "target_filesystem" | "target_invalid" | "workspace_input"
>;

export class InitTargetError extends Error {
  readonly failureCode: InitTargetFailureCode;

  constructor(failureCode: InitTargetFailureCode, message: string) {
    super(message);
    this.failureCode = failureCode;
  }
}
