import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * Appends a UTC time reference to conversation history as user-role instructions when each turn starts.
 *
 * @remarks
 * Previous timestamps remain unchanged, preserving the existing prompt
 * prefix for caching. The timestamp represents turn start, not a live clock.
 */
export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        content: `Current date and time: ${new Date().toISOString()} (UTC).`,
        role: "user",
      }),
  },
});
