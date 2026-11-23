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

export function storageBackend(c: Config): "blob" | "postgres" | "vercel-postgres" {
  return c.database ?? (c.databaseUrl ? "postgres" : "blob");
}
export function store(c: Config): Storage {
  return storageBackend(c) === "blob"
    ? new BlobStore(blobObjects(), namespace(c), c.privacy.retentionDays, c.privacy.ledgerDays)
    : postgresStore(c);
}
