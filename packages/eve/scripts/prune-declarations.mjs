import { execFile } from "node:child_process";
import { readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

// tsc emits a declaration for every module, and vendored packages copy their whole declaration
// tree, but an app's TypeScript only loads the ones eve's `types` exports reach. The rest only
// make the package bigger and slower to install, so the staged package drops them. The
// workspace's own `dist` keeps every declaration for tests that import eve's internals.
//
// Reachability is TypeScript's own, under both module resolutions that read `exports`.
//
// Usage: node scripts/prune-declarations.mjs <staged-package-dir>
const RESOLUTIONS = [
  ["--module", "nodenext", "--moduleResolution", "nodenext"],
  ["--module", "preserve", "--moduleResolution", "bundler"],
];

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const packageRoot = await realpath(resolve(process.argv[2] ?? ".package"));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const roots = [
  ...new Set(
    Object.values(manifest.exports)
      .flatMap((target) => (typeof target === "object" ? Object.values(target) : [target]))
      .filter((target) => typeof target === "string" && target.endsWith(".d.ts"))
      .map((target) => resolve(packageRoot, target)),
  ),
];

const reachable = new Set();
for (const resolution of RESOLUTIONS) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [tsc, "--ignoreConfig", "--listFilesOnly", "--types", "", ...resolution, ...roots],
    { cwd: packageRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  for (const file of stdout.split(/\r?\n/u)) if (file !== "") reachable.add(resolve(file));
}
const missing = roots.filter((root) => !reachable.has(root));
if (missing.length > 0) throw new Error(`tsc did not list the exported ${missing.join(", ")}.`);

const dist = join(packageRoot, "dist");
const unreachable = (await readdir(dist, { recursive: true }))
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => join(dist, file))
  .filter((file) => !reachable.has(file));
await Promise.all(unreachable.map((file) => rm(file)));
console.log(`Removed ${unreachable.length} declarations that no export reaches.`);
