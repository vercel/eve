import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// How big eve is to download and install. Packs the built package directory
// the way pkg.eve.dev does (`pnpm pack`, which stages the package), then, per
// run, installs that tarball into an empty project with npm and an empty
// cache, the way `npm install eve` or `npx eve init` starts for someone new.
// Each run is cold: the install time includes downloading every dependency.
//
// Sizes are apparent sizes (the sum of file lengths, not disk blocks), so
// they don't depend on the runner's filesystem. The tarball and unpacked
// sizes are eve alone; the install sizes are eve plus every dependency and
// required peer npm installs with it.
//
// One JSON object per line: a header, then one result per run.
//
// Usage: node packages/eve/scripts/benchmark-package.mjs <package-dir> [runs]
const execFile = promisify(execFileCallback);
const packageRoot = resolve(process.argv[2] ?? "packages/eve");
const runs = Number(process.argv[3] ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Expected a positive run count.");
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Dependencies listed by installed size in each result, for finding what to cut. */
const LARGEST = 15;

const root = await mkdtemp(join(tmpdir(), "eve-package-benchmark-"));
const tarball = join(root, "eve.tgz");
const env = { ...process.env, EVE_TELEMETRY_DISABLED: "1" };
const { stdout: npmVersion } = await execFile("npm", ["--version"], { env });
console.log(
  JSON.stringify({
    root,
    packageRoot,
    node: process.version,
    npm: npmVersion.trim(),
    platform: process.platform,
    arch: process.arch,
  }),
);

await execFile("pnpm", ["--dir", packageRoot, "pack", "--out", tarball], {
  env,
  maxBuffer: 64 * 1024 * 1024,
});
const packedBytes = (await stat(tarball)).size;
const unpacked = join(root, "unpacked");
await mkdir(unpacked);
await execFile("tar", ["-xzf", tarball, "-C", unpacked]);
const eve = await treeSize(join(unpacked, "package"));

for (let run = 1; run <= runs; run++) {
  const project = join(root, `install-${run}`);
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "eve-package-benchmark", private: true, type: "module" }),
  );
  const start = performance.now();
  await execFile(
    "npm",
    [
      "install",
      tarball,
      "--cache",
      join(root, `npm-cache-${run}`),
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      "--loglevel=error",
    ],
    { cwd: project, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  const installMs = Math.round(performance.now() - start);
  const modules = join(project, "node_modules");
  const installed = await treeSize(modules);
  const packages = await installedPackages(modules);
  const largest = (
    await Promise.all(
      packages.map(async ({ name, dir }) => ({ name, bytes: (await treeSize(dir, true)).bytes })),
    )
  )
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, LARGEST);
  console.log(
    JSON.stringify({
      run,
      mode: "package",
      packedBytes,
      unpackedBytes: eve.bytes,
      unpackedFiles: eve.files,
      installMs,
      installBytes: installed.bytes,
      installFiles: installed.files,
      installPackages: packages.length,
      largest,
    }),
  );
  // The next run starts from nothing; only the tarball is kept.
  await rm(project, { recursive: true, force: true });
  await rm(join(root, `npm-cache-${run}`), { recursive: true, force: true });
}

/**
 * Apparent size of every regular file under `dir`. Symlinks (`.bin` entries)
 * are not followed. With `ownOnly`, nested `node_modules` are left out, so a
 * package's size excludes the copies of dependencies npm nested inside it.
 */
async function treeSize(dir, ownOnly = false) {
  let bytes = 0;
  let files = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(ownOnly && entry.name === "node_modules")) await walk(path);
      } else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        files += 1;
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/** Every installed package (a directory with a package.json), nested copies included. */
async function installedPackages(modules) {
  const found = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const names = entry.name.startsWith("@")
        ? (await readdir(join(dir, entry.name), { withFileTypes: true }))
            .filter((scoped) => scoped.isDirectory())
            .map((scoped) => `${entry.name}/${scoped.name}`)
        : [entry.name];
      for (const name of names) {
        const packageDir = join(dir, name);
        const hasManifest = await stat(join(packageDir, "package.json")).then(
          () => true,
          () => false,
        );
        if (hasManifest) found.push({ name, dir: packageDir });
        await visit(join(packageDir, "node_modules"));
      }
    }
  };
  await visit(modules);
  return found;
}
