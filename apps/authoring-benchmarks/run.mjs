#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
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
  ? resolveLocalSubject()
  : resolveRemoteSubject(
      repository ?? "https://github.com/vercel/eve.git",
      revision ?? "origin/main",
    );
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
const result = spawnSync(executable, experiments, {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    EVE_BENCHMARK_REPOSITORY: subject.repository,
    EVE_BENCHMARK_REVISION: subject.revision,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function resolveLocalSubject() {
  const repository = git(repositoryRoot, ["remote", "get-url", "origin"]).trim();
  const revision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const remoteRefs = execFileSync("git", ["ls-remote", repository], { encoding: "utf8" });
  if (!remoteRefs.includes(revision)) {
    throw new Error(
      `The current commit ${revision.slice(0, 12)} is not reachable from origin. Push it before running the benchmark.`,
    );
  }
  return { repository, revision };
}

function resolveRemoteSubject(repository, requestedRevision) {
  return { repository, revision: resolveRevision(repository, requestedRevision) };
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

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function usage() {
  console.log("Usage: pnpm benchmark:authoring [eval-name] [--all] [--dry] [--force]");
}
