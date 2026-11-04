import { defineDynamic, defineInstructions } from "eve/instructions";

import { formatProjectInstructions, readProjectInstructions } from "../lib/project-instructions.ts";

// Read once per turn: a turn's commands can clone a repository or edit the file.
// As a user instruction, the content joins the conversation only when it changes.
export default defineDynamic(async (ctx) => {
  if (ctx.turn === null) return null;
  const file = await ctx.memo(["project-instructions", ctx.turn.id], async () =>
    readProjectInstructions(await ctx.getSandbox()),
  );
  return file === null
    ? null
    : defineInstructions({ content: formatProjectInstructions(file), role: "user" });
});
