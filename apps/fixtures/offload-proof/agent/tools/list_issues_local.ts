import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, offloadSandbox } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: never(),
  description: "List the issues of the repository as JSON.",
  inputSchema: z.object({}),
  async execute() {
    return JSON.parse(readFileSync(join(process.cwd(), "server/issues.json"), "utf8"));
  },
  toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }),
});
