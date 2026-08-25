import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

const require = createRequire(import.meta.url);

export default defineTool({
  description: "Read deterministic metadata from an external package's sibling asset.",
  inputSchema: z.object({}),
  async execute() {
    const entryPath = require.resolve("zod");
    const packageJson = JSON.parse(
      await readFile(join(dirname(entryPath), "package.json"), "utf8"),
    ) as { name: string; version: string };

    return { payload: `${packageJson.name}@${packageJson.version}` };
  },
});
