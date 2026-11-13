import { defineDynamic, defineInstructions } from "eve/instructions";

/**
 * Appends a UTC time reference to conversation history at each turn.
 *
 * @returns Dynamic user-role instructions resolved when each turn starts.
 * @remarks
 * Previous timestamps remain unchanged, preserving the existing prompt
 * prefix for caching. The timestamp represents turn start, not a live clock.
 */
export const currentTimeInstructions = () =>
  defineDynamic({
    events: {
      "turn.started": () =>
        defineInstructions({
          content: `Current date and time: ${new Date().toISOString()} (UTC).`,
          role: "user",
        }),
    },
  });

export default currentTimeInstructions();
