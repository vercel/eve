/**
 * Entry point for `pnpm build:compiled`. Resolves the per-package configs
 * in `scripts/vendor-compiled/` and delegates the heavy lifting to
 * `runVendor` from the shared library.
 *
 * The directory split mirrors npm package names so each vendored package
 * is one small file. Adding a new vendored dependency means writing a new
 * file in `scripts/vendor-compiled/`, dropping its declaration into
 * `scripts/vendor-compiled/declarations/`, and importing the config from
 * `scripts/vendor-compiled/index.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { collectFilesRecursively, runVendor } from "./vendor-compiled/_shared.mjs";
import { MODULES } from "./vendor-compiled/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const compiledRoot = join(packageRoot, ".generated", "compiled");
const vendorCompiledDir = join(here, "vendor-compiled");

// The stamp fingerprint covers this entry script plus every `.mjs` and
// `.d.ts` under `vendor-compiled/`. When any of those change the stamp
// is invalidated and vendoring re-runs.
const scriptFiles = [
  fileURLToPath(import.meta.url),
  ...(await collectFilesRecursively(vendorCompiledDir, [".mjs", ".d.ts"])),
];

await runVendor({
  packageRoot,
  compiledRoot,
  modules: MODULES,
  scriptFiles,
});
