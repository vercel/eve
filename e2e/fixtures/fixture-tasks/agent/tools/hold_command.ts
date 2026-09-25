import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineTool } from "eve/tools";
import { z } from "zod";

const runFile = promisify(execFile);

export default defineTool({
  description: "Test-only foreground child-process hold.",
  inputSchema: z.object({ durationSeconds: z.literal(45) }),
  async execute({ durationSeconds }) {
    console.error(`[tui-hang-lab] command started; sleeping ${durationSeconds}s`);
    await runFile("sleep", [String(durationSeconds)]);
    console.error("[tui-hang-lab] command completed");
    return { held: `${durationSeconds}s` };
  },
});
