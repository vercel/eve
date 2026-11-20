import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(process.argv[2] ?? "packages/eve");
const runs = Number(process.argv[3] ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("Expected a positive run count.");
const INSTALL_TIMEOUT_MS = 5 * 60_000;
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

const installTimes = [];
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
  installTimes.push(installMs);
  const modules = join(project, "node_modules");
  const installed = await treeSize(modules);
  const packages = await installedPackages(modules);
  const largest = (
    await Promise.all(
      packages.map(async ({ name, version, dir }) => ({
        name,
        version,
        bytes: (await treeSize(dir, true)).bytes,
      })),
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
      installed: packages.map(({ name, version }) => `${name}@${version}`).sort(),
    }),
  );
  await rm(project, { recursive: true, force: true });
  await rm(join(root, `npm-cache-${run}`), { recursive: true, force: true });
}

installTimes.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    mode: "package",
    packedBytes,
    unpackedBytes: eve.bytes,
    installMedianMs: installTimes[Math.floor(installTimes.length / 2)],
  }),
);

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
        const manifest = await readFile(join(packageDir, "package.json"), "utf8").then(
          (text) => JSON.parse(text),
          () => undefined,
        );
        if (manifest !== undefined)
          found.push({ name, version: String(manifest.version ?? "unknown"), dir: packageDir });
        await visit(join(packageDir, "node_modules"));
      }
    }
  };
  await visit(modules);
  return found;
}
