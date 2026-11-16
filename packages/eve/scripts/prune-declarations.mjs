import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
// The repository's templates also import a few internals straight from `node_modules/eve/dist`,
// mostly in tests. Those files are extra roots, so a template still typechecks after upgrading.
// Turbo doesn't hash the templates for this build, but `prepack` reruns the prune, so a cached
// build can't change what gets published.
//
// Usage: node scripts/prune-declarations.mjs <staged-package-dir>
const RESOLUTIONS = [
  ["--module", "nodenext", "--moduleResolution", "nodenext"],
  ["--module", "preserve", "--moduleResolution", "bundler"],
];

// `--listFilesOnly` leaves an import it can't resolve off the list without failing, which would
// delete everything behind it. A full check with `skipLibCheck` off fails on that instead.
const CHECK = [
  "--ignoreConfig",
  "--noEmit",
  "--skipLibCheck",
  "false",
  "--listFiles",
  "--types",
  "",
];

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const packageRoot = await realpath(resolve(process.argv[2] ?? ".package"));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
// Conditions can nest, so walk every string target under `exports` and `types`.
const targets = (value) =>
  typeof value === "string" ? [value] : Object.values(value ?? {}).flatMap(targets);
const DECLARATION = /\.d\.[cm]?ts$/u;
// An export without its own declaration would have TypeScript fall back to one this prune
// doesn't treat as a root, so it would be deleted.
for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
  const subpathTargets = targets(value);
  if (
    subpathTargets.some((target) => /\.[cm]?js$/u.test(target)) &&
    !subpathTargets.some((target) => DECLARATION.test(target))
  ) {
    throw new Error(`The "${subpath}" export has no declaration target.`);
  }
}
const exported = targets([manifest.exports, manifest.types])
  .filter((target) => DECLARATION.test(target))
  .map((target) => resolve(packageRoot, target));

const templatesDirectory = resolve(import.meta.dirname, "..", "..", "..", "apps", "templates");
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  ".eve",
  ".vercel",
]);
const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/u;
const DIST_IMPORT = /node_modules\/eve\/(dist\/[^"'`\s]+?)\.js["'`]/gu;
const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
      return entry.isFile() && SOURCE_FILE.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
};
const templateImported = [];
for (const file of await sourceFiles(templatesDirectory)) {
  for (const [, target] of (await readFile(file, "utf8")).matchAll(DIST_IMPORT)) {
    const declaration = resolve(packageRoot, `${target}.d.ts`);
    if (!existsSync(declaration)) {
      throw new Error(`${file} imports eve/${target}.js, which has no declaration to keep.`);
    }
    templateImported.push(declaration);
  }
}

const roots = [...new Set([...exported, ...templateImported])];

const reachable = new Set();
for (const resolution of RESOLUTIONS) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [tsc, ...CHECK, ...resolution, ...roots],
    { cwd: packageRoot, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error) => {
    const errors = String(error.stdout)
      .split(/\r?\n/u)
      .filter((line) => line.includes(" TS"));
    throw new Error(`eve's declarations do not typecheck:\n${errors.join("\n") || error.message}`);
  });
  for (const file of stdout.split(/\r?\n/u)) if (file !== "") reachable.add(resolve(file));
}
const missing = roots.filter((root) => !reachable.has(root));
if (missing.length > 0) throw new Error(`tsc did not list the root ${missing.join(", ")}.`);

const dist = join(packageRoot, "dist");
const unreachable = (await readdir(dist, { recursive: true }))
  .filter((file) => file.endsWith(".d.ts"))
  .map((file) => join(dist, file))
  .filter((file) => !reachable.has(file));
await Promise.all(unreachable.map((file) => rm(file)));
console.log(
  `Removed ${unreachable.length} declarations that no export or template import reaches.`,
);
