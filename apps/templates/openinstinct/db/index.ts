import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@shared/environment";
import * as schema from "./schema";

export * from "./schema";

const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });
