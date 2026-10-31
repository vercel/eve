import { defineDynamic, defineInstructions } from "eve/instructions";

import { loops } from "./lib/state.ts";

// A system instruction, not a message: tool output can't imitate it, and it stays outside the
// history that compaction rewrites. It lasts for the rest of the turn it was given in.
export default defineDynamic((ctx) => {
  const current = loops.get();
  if (current?.nudge === undefined || current.turnId !== ctx.turn?.id) return null;
  return defineInstructions({ content: current.nudge });
});
