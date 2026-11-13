import { defineConfig } from "drizzle-kit";
import { dbMigrationEnv } from "./env/migration";

export default defineConfig({
  dbCredentials: { url: dbMigrationEnv.DATABASE_URL_UNPOOLED },
  dialect: "postgresql",
  out: "./db/migrations",
  schema: "./db/schema/index.ts",
});
