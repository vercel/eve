import { Pool } from "#compiled/pg/index.js";

import type {
  ComputeQueryExecutor,
  ComputeQueryResult,
  ComputeStorage,
  SqlParameter,
} from "#compute/storage/types.js";

export interface PostgresStorageOptions {
  connectionString: string;
  applicationName?: string;
  maxConnections?: number;
  ssl?: boolean | { ca?: string; rejectUnauthorized: boolean };
}

function createQueryExecutor(client: {
  query<Row extends Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null } | { rows: Row[]; rowCount: number | null }[]>;
}): ComputeQueryExecutor {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      parameters: readonly SqlParameter[] = [],
    ): Promise<ComputeQueryResult<Row>> {
      const queryResult = await client.query<Row>(text, [...parameters]);
      const result = Array.isArray(queryResult) ? queryResult.at(-1) : queryResult;
      if (result === undefined) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    },
  };
}

export function createPostgresStorage(options: PostgresStorageOptions): ComputeStorage {
  const pool = new Pool({
    application_name: options.applicationName,
    connectionString: options.connectionString,
    max: options.maxConnections,
    ssl: options.ssl,
  });
  const executor = createQueryExecutor(pool);

  return {
    ...executor,
    async transaction<T>(operation: (transaction: ComputeQueryExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const transaction = createQueryExecutor(client);
      try {
        await transaction.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const result = await operation(transaction);
        await transaction.query("COMMIT");
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
