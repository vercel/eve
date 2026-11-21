#!/usr/bin/env node
/**
 * Serves the database the Postgres world suite runs against: postgres:18-alpine
 * on 127.0.0.1:5432 with the `world` database, user, and password. It pulls the
 * official image from its ECR Public mirror, which has no Docker Hub pull
 * limit. It stays up until Turbo stops it, then removes the container. Each
 * fixture's `e2e:postgres` task starts it with Turbo's `with`, so on Vercel CI
 * every fixture gets its own database.
 */
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CONTAINER = "eve-e2e-postgres";

const docker = (args, options = {}) =>
  execFileSync("docker", args, { stdio: "ignore", ...options });
const removeContainer = () => {
  try {
    docker(["rm", "--force", CONTAINER]);
  } catch {}
};

removeContainer();
const container = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    CONTAINER,
    "--env",
    "POSTGRES_DB=world",
    "--env",
    "POSTGRES_PASSWORD=world",
    "--env",
    "POSTGRES_USER=world",
    "--publish",
    "127.0.0.1:5432:5432",
    "public.ecr.aws/docker/library/postgres:18-alpine",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
container.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    removeContainer();
    process.exit(0);
  });
}

let ready = false;
for (let attempt = 0; attempt < 120 && !ready; attempt++) {
  try {
    docker([
      "exec",
      CONTAINER,
      "pg_isready",
      "--host=127.0.0.1",
      "--username=world",
      "--dbname=world",
    ]);
    ready = true;
  } catch {
    await sleep(1_000);
  }
}
if (!ready) {
  try {
    docker(["logs", CONTAINER], { stdio: "inherit" });
  } catch {}
  removeContainer();
  throw new Error(`PostgreSQL in container ${CONTAINER} was not ready after 120 seconds.`);
}
console.log("PostgreSQL is accepting connections at 127.0.0.1:5432.");
