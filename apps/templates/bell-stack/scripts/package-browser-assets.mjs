import { copyFile, glob, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Eve's dependency tracing omits the archive Stagehand uploads when creating a hosted browser.
const source = new URL("./assets/stagehand-extension.zip", import.meta.resolve("@browserbasehq/stagehand"));
const output = process.env.VERCEL ? ".vercel/output" : ".output";
let copied = 0;
for await (const directory of glob("**/node_modules/@browserbasehq/stagehand/dist", { cwd: output })) {
  const destination = join(output, directory, "assets");
  await mkdir(destination, { recursive: true });
  await copyFile(source, join(destination, "stagehand-extension.zip"));
  copied++;
}
if (!copied) throw new Error("The built Eve server is missing Stagehand; browser assets were not packaged.");
