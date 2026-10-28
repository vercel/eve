import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { copyCompiledAssets } from "./copy-compiled-assets.mjs";
import { copyRuntimeAssets } from "./copy-runtime-assets.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

await run(["./scripts/vendor-compiled.mjs"]);
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
// Declarations and JavaScript have disjoint outputs. Drain both before packaging.
const results = await Promise.allSettled([
  run([
    join(dirname(require.resolve("typescript/package.json")), "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
  ]),
  run(["--conditions=eve-source", "./scripts/build-rolldown.mjs"]),
  copyCompiledAssets(),
]);
const errors = results
  .filter((result) => result.status === "rejected")
  .map((result) => result.reason);
if (errors.length > 0) throw new AggregateError(errors, "Failed to build eve.");
await copyRuntimeAssets();

async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: packageRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${signal ?? code}`)),
    );
  });
}
