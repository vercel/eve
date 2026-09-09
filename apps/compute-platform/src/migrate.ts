import { pathToFileURL } from "node:url";

import {
  createPostgresStorage,
  migrateComputeStorage,
  type ComputeStorage,
} from "eve/internal/compute-platform";

import { computePlatformConfig } from "./config.ts";

async function waitForStorage(storage: ComputeStorage): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await storage.query("SELECT 1");
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function grantLocalRoleAccess(admin: ComputeStorage): Promise<void> {
  await admin.query(`
    GRANT USAGE ON SCHEMA compute TO eve_compute_runtime, eve_compute_inspector;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA compute
      TO eve_compute_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA compute
      TO eve_compute_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA compute TO eve_compute_inspector;
    ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eve_compute_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO eve_compute_runtime;
    ALTER DEFAULT PRIVILEGES FOR ROLE eve_compute_migrator IN SCHEMA compute
      GRANT SELECT ON TABLES TO eve_compute_inspector;
  `);
}

export async function migrateLocalComputeDatabase(): Promise<void> {
  const migrator = createPostgresStorage({
    applicationName: "eve-compute-migrator",
    connectionString: computePlatformConfig.migratorUrl,
    maxConnections: 1,
  });
  const admin = createPostgresStorage({
    applicationName: "eve-compute-local-admin",
    connectionString: computePlatformConfig.adminUrl,
    maxConnections: 1,
  });

  try {
    await waitForStorage(migrator);
    const result = await migrateComputeStorage(migrator);
    await grantLocalRoleAccess(admin);
    process.stdout.write(
      `Compute schema ready at version ${result.currentVersion}; applied: ${result.applied.join(", ") || "none"}.\n`,
    );
  } finally {
    await Promise.all([migrator.close(), admin.close()]);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateLocalComputeDatabase();
}
