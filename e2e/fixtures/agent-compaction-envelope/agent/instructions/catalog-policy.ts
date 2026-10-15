import type { HookEvent } from "eve/hooks";
import { defineDynamic, defineInstructions } from "eve/instructions";

export default defineDynamic({
  events: {
    "turn.started": (event) => {
      // The preamble cannot read this turn's message yet; six seed turns precede expansion. A
      // session numbers its turns in their ids: `turn_0`, `turn_1`, and so on.
      const { turnId } = (event as HookEvent<"turn.started">).data;
      if (Number(turnId.slice("turn_".length)) < 6) return null;
      return defineInstructions({
        role: "system",
        content: `EXPANDED_POLICY ${"Use the configured catalog policy. ".repeat(140)}`,
      });
    },
  },
});
