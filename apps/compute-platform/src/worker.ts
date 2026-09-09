import { pathToFileURL } from "node:url";

import { assertComputeSchemaReady, createPostgresStorage } from "eve/internal/compute-platform";

import { computePlatformConfig } from "./config.ts";

export async function runSupervisor(workerId: string): Promise<void> {
  const storage = createPostgresStorage({
    applicationName: `eve-compute-worker-${workerId}`,
    connectionString: computePlatformConfig.runtimeUrl,
    maxConnections: 2,
  });

  try {
    const schemaVersion = await assertComputeSchemaReady(storage);
    process.stdout.write(
      `${JSON.stringify({ role: "supervisor", schemaVersion, status: "ready", workerId })}\n`,
    );

    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 60_000);
      const stop = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await storage.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSupervisor(process.argv[2] ?? `local-${process.pid}`);
}
