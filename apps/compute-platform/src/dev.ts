import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { runCompose } from "./docker.ts";
import { migrateLocalComputeDatabase } from "./migrate.ts";

const workerEntrypoint = fileURLToPath(new URL("./worker.ts", import.meta.url));

function startWorker(workerId: string): ChildProcess {
  return spawn(process.execPath, ["--conditions=eve-source", workerEntrypoint, workerId], {
    env: process.env,
    stdio: "inherit",
  });
}

await runCompose(["up", "-d", "postgres"]);
await migrateLocalComputeDatabase();

const workers = [startWorker("local-a"), startWorker("local-b")];
process.stdout.write("Compute PostgreSQL and two A1 supervisor bootstraps are running.\n");

let stopping = false;
let stopPromise: Promise<void> | undefined;

function stopWorkers(): Promise<void> {
  stopPromise ??= Promise.all(
    workers.map(async (worker) => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
    }),
  ).then(() => undefined);
  return stopPromise;
}

function requestStop(): void {
  stopping = true;
  void stopWorkers();
}

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
const exitedWorker = await Promise.race(
  workers.map(async (worker) => {
    await once(worker, "exit");
    return worker;
  }),
);
await stopWorkers();

if (!stopping) {
  throw new Error(
    `Compute supervisor ${exitedWorker.pid ?? "unknown"} exited before shutdown was requested.`,
  );
}
