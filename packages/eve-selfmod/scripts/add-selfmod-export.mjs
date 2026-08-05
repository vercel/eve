import { appendFile } from "node:fs/promises";

await Promise.all([
  appendFile("dist/index.mjs", '\nexport { defineSelfmod } from "../scaffold/index.js";\n'),
  appendFile(
    "dist/index.d.ts",
    '\nexport { defineSelfmod, type SelfmodOptions } from "../scaffold/index.js";\n',
  ),
]);
