import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { writeLocalComputeAccessFile } from "./access.ts";
import { bootstrapLocalComputeNamespace } from "./bootstrap.ts";
import { computePlatformConfig, requireComputeToken } from "./config.ts";
import { runCompose } from "./docker.ts";
import { startLocalComputeGateway } from "./gateway.ts";
import { migrateLocalComputeDatabase } from "./migrate.ts";

const workerEntrypoint = fileURLToPath(new URL("./worker.ts", import.meta.url));

function startWorker(workerId: string): ChildProcess {
  const env = { ...process.env };
  delete env.EVE_COMPUTE_ACCESS_FILE;
  delete env.EVE_COMPUTE_ADMIN_URL;
  delete env.EVE_COMPUTE_INSPECTOR_URL;
  delete env.EVE_COMPUTE_MIGRATOR_URL;
  delete env.EVE_COMPUTE_TOKEN;
  return spawn(process.execPath, ["--conditions=eve-source", workerEntrypoint, workerId], {
    env,
    stdio: "inherit",
  });
}

requireComputeToken();
await runCompose(["up", "-d", "postgres"]);
await migrateLocalComputeDatabase();
await bootstrapLocalComputeNamespace();
await writeLocalComputeAccessFile();
delete process.env.EVE_COMPUTE_TOKEN;
const gateway = await startLocalComputeGateway();

const workers = [startWorker("local-a"), startWorker("local-b")];
process.stdout.write(
  `Compute gateway ${gateway.url} and two supervisor bootstraps are running.\n` +
    `Namespace: ${computePlatformConfig.namespaceId}\n`,
);

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
  )
    .then(() => gateway.server.close())
    .then(() => undefined);
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
