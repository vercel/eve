export interface HumanAction {
  readonly kind: string;
  readonly command: string;
  readonly reason: string;
}

export class HumanActionRequiredError extends Error {
  readonly action: HumanAction;

  constructor(action: HumanAction) {
    super(`Human action required: \`${action.command}\` — ${action.reason}`);
    this.name = "HumanActionRequiredError";
    this.action = action;
  }
}
