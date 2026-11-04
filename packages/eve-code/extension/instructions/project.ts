import { calls } from "eve/events";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { formatProjectInstructions, readProjectInstructions } from "../lib/project-instructions.ts";

// The file can change only through tool calls, so it is read on the first turn and
// again at the start of a turn that follows tool calls. A turn without earlier tool
// activity reuses the saved result and starts no sandbox. As a user instruction, the
// content joins the conversation only when it changes.
export default defineDynamic(async (ctx) => {
  const turn = ctx.turn;
  if (turn === null) return null;
  const earlierCalls = calls(ctx.view).filter((call) => call.turnId !== turn.id).length;
  try {
    const file = await ctx.memo(["project-instructions", earlierCalls], async () =>
      readProjectInstructions(await ctx.getSandbox()),
    );
    return file === null
      ? null
      : defineInstructions({ content: formatProjectInstructions(file), role: "user" });
  } catch {
    // Project instructions are optional; a failed read must not fail the turn, and stays uncached.
    return null;
  }
});
