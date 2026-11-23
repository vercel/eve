import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

if (process.argv.includes("--vercel-build") && process.env.VERCEL_ENV === "preview") {
  console.info("Skipping database migrations on Vercel preview builds.");
} else {
  const { dbMigrationEnv } = await import("../lib/db/migration-env.ts");
  const pool = new Pool({
    connectionString: dbMigrationEnv.DATABASE_URL_UNPOOLED,
  });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: fileURLToPath(new URL("../migrations/postgres/", import.meta.url)),
    });
  } finally {
    await pool.end();
  }
}
