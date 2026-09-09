import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { resolveTaskPath } from "../task-path.js";

export default defineTool({
  approval: never(),
  description:
    "Create or replace a UTF-8 text file in the task environment. Parent directories are created automatically.",
  inputSchema: z.object({
    path: z.string().describe("Absolute path or path relative to the task working directory."),
    content: z.string(),
  }),
  async execute({ path, content }) {
    const resolved = resolveTaskPath(path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return { bytesWritten: Buffer.byteLength(content), path: resolved };
  },
});
