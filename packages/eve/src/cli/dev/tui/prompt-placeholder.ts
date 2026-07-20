/**
 * The empty prompt's rotating invitation, written in the agent's own voice
 * ("my capabilities") since the prompt is a message to it. Messages point at
 * things an eve agent can actually do out of the box, so an idle prompt
 * doubles as a hint surface. The caret-blink repaint keeps the rotation
 * moving without its own timer.
 */

export const PROMPT_PLACEHOLDER_MESSAGES: readonly string[] = [
  "Ask about my capabilities",
  "Have me explore the workspace",
  "Refine my instructions",
];

/** How long each message holds before the rotation advances. */
export const promptPlaceholderCycleMs = 6_000;

/** Picks the message for the given time since the renderer started. */
export function promptPlaceholder(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / promptPlaceholderCycleMs);
  return PROMPT_PLACEHOLDER_MESSAGES[index % PROMPT_PLACEHOLDER_MESSAGES.length]!;
}
