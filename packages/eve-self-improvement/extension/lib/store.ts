import { namespace, type Config } from "./config.js";
import { BlobStore, blobObjects } from "./blob-store.js";
import { postgresStore } from "./postgres-store.js";
import type { Storage } from "./storage.js";

export {
  PostgresStore as Store,
  databaseConnection,
  closeStores,
  type Sql,
} from "./postgres-store.js";
export { BlobStore } from "./blob-store.js";
export type { Storage } from "./storage.js";

/** Selects private Blob by default while preserving an explicitly configured existing Postgres ledger. */
export function storageBackend(
  c: Config,
  env: NodeJS.ProcessEnv = process.env,
): "blob" | "postgres" | "vercel-postgres" {
  return (
    c.database ??
    (c.databaseUrl || env.EVE_EVOLUTION_DATABASE_URL || env.POSTGRES_URL || env.DATABASE_URL
      ? "postgres"
      : "blob")
  );
}
/** Creates the configured private evidence store without falling back across backends on errors. */
export function store(c: Config): Storage {
  return storageBackend(c) === "blob"
    ? new BlobStore(blobObjects(), namespace(c), c.privacy.retentionDays, c.privacy.ledgerDays)
    : postgresStore(c);
}
