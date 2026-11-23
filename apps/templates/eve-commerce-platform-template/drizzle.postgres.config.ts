import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations/postgres",
  schema: "./lib/db/schema.ts",
});
