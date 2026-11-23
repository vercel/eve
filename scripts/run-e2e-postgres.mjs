#!/usr/bin/env node
/**
 * Runs one fixture's Postgres world suite: bootstrap the Workflow schema, build
 * the fixture, start its production server, run the mock-model evals against
 * it, and check that the runs reached PostgreSQL. Each fixture in that world
 * runs this from its directory as its `e2e:postgres` Turbo task, which starts a
 * fresh database (@eve-e2e/postgres) alongside it with Turbo's `with`. It
 * serves on port 3000, where the fixtures and the Postgres world call back by
 * default, so run one fixture at a time. Under CI it first moves the extension
 * fixtures' source aside, so the build consumes the same agent-shaped dist
 * trees registry packages ship.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveSandboxImage } from "./resolve-sandbox-image.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const fixture = basename(process.cwd());
const { worlds } = JSON.parse(readFileSync(join(repoRoot, "e2e", "matrix.json"), "utf8"));
const world = worlds.find((entry) => entry.name === "postgres");
const container = "eve-e2e-postgres";
const url = "http://127.0.0.1:3000";
const work = mkdtempSync(join(tmpdir(), `eve-e2e-postgres-${fixture}-`));
const serverLog = join(work, "server.log");
const junit = join(work, `${fixture}.xml`);
const stagedSources = process.env.CI
  ? ["toolkit-extension", "js-only-extension"].map((name) =>
      join(repoRoot, "e2e", "fixtures", name, "extension"),
    )
  : [];

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });
const capture = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const request = (path) =>
  fetch(`${url}${path}`, { signal: AbortSignal.timeout(2_000) }).then(
    (response) => response,
    () => undefined,
  );
const printServerLog = () => {
  if (existsSync(serverLog)) process.stdout.write(readFileSync(serverLog, "utf8"));
};

let server;
const moved = [];
const cleanUp = () => {
  if (server?.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
  for (const source of moved.splice(0)) renameSync(`${source}.e2e-staged`, source);
  rmSync(work, { force: true, recursive: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanUp();
    process.exit(1);
  });
}

try {
  if ((await request("/")) !== undefined) {
    throw new Error(
      `${url} is already serving. Stop that process first, because each fixture's suite serves on port 3000.`,
    );
  }
  resolveSandboxImage();
  let ready = false;
  for (let attempt = 0; attempt < 180 && !ready; attempt++) {
    try {
      execFileSync(
        "docker",
        ["exec", container, "pg_isready", "--host=127.0.0.1", "--username=world", "--dbname=world"],
        { stdio: "ignore" },
      );
      ready = true;
    } catch {
      await sleep(1_000);
    }
  }
  if (!ready) {
    throw new Error(
      `PostgreSQL in container ${container} was not ready after 180 seconds. @eve-e2e/postgres#postgres starts it; run this through \`turbo run <fixture>#e2e:postgres\`.`,
    );
  }

  const env = {
    ...process.env,
    AI_GATEWAY_API_KEY: "invalid-e2e-world-suite-key",
    EVE_E2E_MODEL: "mock",
    EVE_E2E_WORKFLOW_WORLD: world.package,
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: "52",
    WORKFLOW_POSTGRES_URL: "postgres://world:world@127.0.0.1:5432/world",
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "50",
  };
  for (const source of stagedSources) {
    renameSync(source, `${source}.e2e-staged`);
    moved.push(source);
    console.log(`Moved ${source} aside, so the build uses that extension's dist tree.`);
  }
  run("pnpm", ["exec", "bootstrap"], { env });
  run("pnpm", ["exec", "eve", "build"], { env });

  const log = openSync(serverLog, "w");
  server = spawn(
    "pnpm",
    ["exec", "eve", "start", "--host", "127.0.0.1", "--port", new URL(url).port],
    { detached: true, env: { ...env, EVE_DEV: "1" }, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt++) {
    if (server.exitCode !== null) {
      printServerLog();
      throw new Error(`The eve server exited with code ${server.exitCode} before it was healthy.`);
    }
    healthy = (await request("/eve/v1/health"))?.ok === true;
    if (!healthy) await sleep(500);
  }
  if (!healthy) {
    printServerLog();
    throw new Error("Timed out waiting for the Postgres-backed eve server.");
  }

  try {
    run(
      "pnpm",
      [
        "exec",
        "eve",
        "eval",
        "--strict",
        "--verbose",
        "--exclude-tag",
        "real-model",
        "--url",
        url,
        "--junit",
        junit,
      ],
      { env },
    );
  } catch (error) {
    printServerLog();
    throw error;
  }

  const report = existsSync(junit) ? readFileSync(junit, "utf8") : "";
  const count = (attribute) =>
    Number(report.match(new RegExp(`${attribute}="(\\d+)"`, "u"))?.[1] ?? 0);
  if (count("tests") - count("skipped") === 0) {
    console.log(
      "No evals executed on this world; build/boot/health verified, persistence assertion skipped.",
    );
  } else {
    const runs = capture("docker", [
      "exec",
      container,
      "psql",
      "--username=world",
      "--dbname=world",
      "--tuples-only",
      "--no-align",
      "--command=SELECT count(*) FROM workflow.workflow_runs;",
    ]);
    if (!/^\d+$/u.test(runs) || Number(runs) < 1) {
      printServerLog();
      throw new Error(`Expected Postgres-backed workflow runs, found: ${runs}`);
    }
    console.log(`Verified ${runs} workflow run(s) in PostgreSQL.`);
  }
} finally {
  cleanUp();
}
