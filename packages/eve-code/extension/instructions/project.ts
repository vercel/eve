import { defineDynamic, defineInstructions } from "eve/instructions";

import { formatProjectInstructions, readProjectInstructions } from "../lib/project-instructions.ts";

// Read once per session, on the first turn, like pi reads it at startup. As a user
// instruction, the content stays in the conversation without being added again.
export default defineDynamic(async (ctx) => {
  if (ctx.turn === null) return null;
  try {
    const file = await ctx.memo("project-instructions", async () =>
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
