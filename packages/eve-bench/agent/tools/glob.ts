import { glob } from "node:fs/promises";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { resolveTaskPath, taskRoot } from "../task-path.js";

export default defineTool({
  approval: never(),
  description: "Find task-environment files whose paths match a glob pattern.",
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string().optional().describe("Search root relative to the task working directory."),
  }),
  async execute({ pattern, path }) {
    const cwd = path === undefined ? taskRoot() : resolveTaskPath(path);
    const matches: string[] = [];
    for await (const match of glob(pattern, { cwd })) matches.push(match);
    return { matches: matches.sort() };
  },
});
