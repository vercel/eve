import nextEnv from "@next/env";
import { createEnv } from "@t3-oss/env-nextjs";
import { databaseUrlSchema } from "../environment/database-url.ts";

nextEnv.loadEnvConfig(process.cwd());

export const dbMigrationEnv = createEnv({
  server: {
    DATABASE_URL_UNPOOLED: databaseUrlSchema,
  },
  experimental__runtimeEnv: {},
});
