import { defineDynamic, defineInstructions } from "eve/instructions";

import { formatWorkspaceContext, readProjectInstructions } from "../lib/project-instructions.ts";

export default defineDynamic(async (ctx) => {
  if (ctx.turn === null) return null;
  try {
    const workspace = await ctx.memo("project-instructions", async () => {
      const sandbox = await ctx.getSandbox();
      return {
        file: await readProjectInstructions(sandbox),
        workingDirectory: sandbox.resolvePath("."),
      };
    });
    return defineInstructions({
      content: formatWorkspaceContext(workspace.workingDirectory, workspace.file),
      role: "user",
    });
  } catch {
    return null;
  }
});
