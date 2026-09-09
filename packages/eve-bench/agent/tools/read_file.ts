import { readFile } from "node:fs/promises";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { resolveTaskPath } from "../task-path.js";

export default defineTool({
  approval: never(),
  description:
    "Read a UTF-8 text file from the task environment, optionally selecting an inclusive 1-based line range.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path or path relative to the task working directory."),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  async execute({ path, startLine, endLine }) {
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
      throw new Error("startLine must not exceed endLine.");
    }
    const content = await readFile(resolveTaskPath(path), "utf8");
    if (startLine === undefined && endLine === undefined) return { content };
    const lines = content.split(/(?<=\n)/u);
    return { content: lines.slice((startLine ?? 1) - 1, endLine).join("") };
  },
});
