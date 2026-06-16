/**
 * Refusal shown by agent-scoped commands (`eve link`, `eve deploy`,
 * `eve channels …`) when the working directory holds no Eve agent.
 */
export const NOT_AN_AGENT_MESSAGE =
  "No Eve agent in this directory. Run `eve init <name>`, then run this command from inside the new project.";

/** True when stdin and stdout are both TTYs — the default interactivity gate. */
export function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
