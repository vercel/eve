/**
 * A step that an automated (headless) run cannot perform itself because it
 * requires the user's browser or login — for example `vercel link` or
 * `vercel login`. The caller surfaces `command` for the human to run and then
 * resume the flow when that action is complete.
 */
export interface HumanAction {
  /** Stable identifier for the kind of action, e.g. `"vercel-link"`. */
  readonly kind: string;
  /** The exact command the user should run. */
  readonly command: string;
  /** Why the flow needs it, in one human-readable sentence. */
  readonly reason: string;
}

/**
 * Thrown by shared setup steps when running headlessly and the next step needs
 * a human/browser action. Headless callers catch this and emit a structured
 * `action-required` record instead of blocking on an interactive subprocess.
 */
export class HumanActionRequiredError extends Error {
  readonly action: HumanAction;

  constructor(action: HumanAction) {
    super(`Human action required: \`${action.command}\` — ${action.reason}`);
    this.name = "HumanActionRequiredError";
    this.action = action;
  }
}
