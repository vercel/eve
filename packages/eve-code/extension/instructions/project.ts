import { defineDynamic, defineInstructions } from "eve/instructions";

import { formatProjectInstructions, readProjectInstructions } from "../lib/project-instructions.ts";

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
    return null;
  }
});
