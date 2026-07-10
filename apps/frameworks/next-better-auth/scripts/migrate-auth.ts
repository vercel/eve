import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../lib/auth.ts";

const migrations = await getMigrations(authOptions);
await migrations.runMigrations();

console.log("Better Auth schema is up to date.");
