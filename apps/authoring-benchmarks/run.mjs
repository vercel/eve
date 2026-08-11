#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
const cacheRoot = join(repositoryRoot, ".eve/authoring-benchmarks/packages");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    all: { type: "boolean" },
    dry: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  usage();
  process.exit(0);
}
if (positionals.length > 1) throw new Error("Expected at most one <eval-name>.");
if (values.all && positionals.length > 0)
  throw new Error("--all cannot be combined with an eval name.");

const repository = process.env.EVE_BENCHMARK_REPOSITORY;
const revision = process.env.EVE_BENCHMARK_REVISION;
const local = repository === undefined && revision === undefined;
if (local && git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
  throw new Error(
    "The local checkout has tracked changes. Commit them or set EVE_BENCHMARK_REPOSITORY and EVE_BENCHMARK_REVISION to a clean subject revision.",
  );
}
const subject = local
  ? { root: repositoryRoot, revision: git(repositoryRoot, ["rev-parse", "HEAD"]).trim() }
  : prepareRemoteCheckout(
      repository ?? "https://github.com/vercel/eve.git",
      revision ?? "origin/main",
    );
const tarball = prepareTarball(subject.root, subject.revision);
const executable = join(appRoot, "node_modules/.bin/agent-eval");
mkdirSync(join(appRoot, "results"), { recursive: true });
const selectedEval = positionals[0];
if (selectedEval !== undefined && selectedEval !== "author-000-imessage") {
  throw new Error(`Unknown eval ${JSON.stringify(selectedEval)}.`);
}
const experiments = values.dry
  ? ["status"]
  : ["run", "baseline", "agents-md", ...(values.force === true ? ["--force"] : [])];

console.log(`> Subject revision: ${subject.revision.slice(0, 12)}`);
console.log(`> eve package: ${tarball} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`);
const result = spawnSync(executable, experiments, {
  cwd: appRoot,
  stdio: "inherit",
  env: { ...process.env, EVE_AUTHORING_TARBALL: tarball },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function prepareRemoteCheckout(repository, requestedRevision) {
  const revision = resolveRevision(repository, requestedRevision);
  const root = join(cacheRoot, revision, "source");
  if (!existsSync(join(root, ".git"))) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", repository, root], {
      stdio: "inherit",
    });
  }
  execFileSync("git", ["-C", root, "fetch", "--depth", "1", "origin", revision], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", root, "checkout", "--detach", "--force", "FETCH_HEAD"], {
    stdio: "inherit",
  });
  return { root, revision };
}

function resolveRevision(repository, revision) {
  if (/^[0-9a-f]{40}$/iu.test(revision)) return revision.toLowerCase();
  const normalized = revision.startsWith("origin/") ? revision.slice("origin/".length) : revision;
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      repository,
      normalized,
      `refs/heads/${normalized}`,
      `refs/tags/${normalized}^{}`,
      `refs/tags/${normalized}`,
    ],
    { encoding: "utf8" },
  );
  const resolved = output.match(/^[0-9a-f]{40}/imu)?.[0];
  if (resolved === undefined)
    throw new Error(`Could not resolve revision ${JSON.stringify(revision)}.`);
  return resolved.toLowerCase();
}

function prepareTarball(root, revision) {
  const directory = join(cacheRoot, revision);
  const target = join(directory, "eve.tgz");
  if (existsSync(target)) return target;

  mkdirSync(directory, { recursive: true });
  console.log("> Installing and building subject checkout...");
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "eve", "build"], { cwd: root, stdio: "inherit" });
  const output = execFileSync("pnpm", ["pack", "--pack-destination", directory], {
    cwd: join(root, "packages/eve"),
    encoding: "utf8",
  });
  const produced = output.trim().split("\n").at(-1);
  if (produced === undefined) throw new Error("pnpm pack did not report an eve tarball.");
  renameSync(isAbsolute(produced) ? produced : join(directory, produced), target);
  return target;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function usage() {
  console.log("Usage: pnpm benchmark:authoring [eval-name] [--all] [--dry] [--force]");
}
