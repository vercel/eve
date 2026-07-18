/**
 * The empty prompt's rotating invitation. Messages point at things an eve
 * agent can actually do out of the box — chat, workspace inspection, skills,
 * instructions — so an idle prompt doubles as a hint surface. The caret-blink
 * repaint keeps the rotation moving without its own timer.
 */

export const PROMPT_PLACEHOLDER_MESSAGES: readonly string[] = [
  "Chat with your agent",
  "List your workspace",
  "Teach your agent a new skill",
  "Ask what your agent can do",
  "Refine your agent's instructions",
];

/** How long each message holds before the rotation advances. */
export const promptPlaceholderCycleMs = 6_000;

/** Picks the message for the given time since the renderer started. */
export function promptPlaceholder(elapsedMs: number): string {
  const index = Math.floor(Math.max(0, elapsedMs) / promptPlaceholderCycleMs);
  return PROMPT_PLACEHOLDER_MESSAGES[index % PROMPT_PLACEHOLDER_MESSAGES.length]!;
}
